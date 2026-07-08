const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.set('trust proxy', true);

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: true,
        methods: ['GET', 'POST']
    }
});

const fs = require('fs');
const ROOMS_FILE = path.join(__dirname, 'rooms.json');

// Serve frontend files from the 'Public' directory
app.use(express.static('Public'));

// Serve local client libraries from node_modules to avoid external CDN/blocking issues
app.use('/js/peerjs', express.static(path.join(__dirname, 'node_modules', 'peerjs', 'dist')));
app.use('/js/socket.io', express.static(path.join(__dirname, 'node_modules', 'socket.io', 'client-dist')));

app.get('/health', (req, res) => {
    res.status(200).send('ok');
});

// Per-room state storage
// rooms: { [roomId]: { currentVideo, playlist, queue, users: { socketId: { username, peerId, mediaState } }, speakingUsers: Set } }
let rooms = {};
let users = {}; // Track users globally: { socketId: { username, peerId, mediaState, room } }

// Load persisted rooms from disk (only video/playlist/queue will be persisted)
function loadRooms() {
    try {
        if (fs.existsSync(ROOMS_FILE)) {
            const raw = fs.readFileSync(ROOMS_FILE, 'utf8');
            const parsed = JSON.parse(raw || '{}');
            // Reconstruct rooms with runtime-only fields
            Object.entries(parsed).forEach(([rid, data]) => {
                rooms[rid] = {
                    currentVideo: data.currentVideo || { platform: 'youtube', id: 'dQw4w9WgXcQ' },
                    playlist: data.playlist || [],
                    queue: data.queue || [],
                        users: {},
                        speakingUsers: new Set(),
                        ownerId: null,
                        ownerName: data.ownerName || null
                };
            });
            console.log('Loaded persisted rooms from', ROOMS_FILE);
        }
    } catch (e) {
        console.warn('Failed to load rooms file:', e.message);
    }
}

let _saveTimer = null;
function scheduleSaveRooms(delay = 500) {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(saveRooms, delay);
}

function saveRooms() {
    try {
        const toSave = {};
        Object.entries(rooms).forEach(([rid, room]) => {
            toSave[rid] = {
                currentVideo: room.currentVideo,
                playlist: room.playlist,
                queue: room.queue,
                ownerName: room.ownerName || null
            };
        });
        fs.writeFileSync(ROOMS_FILE, JSON.stringify(toSave, null, 2), 'utf8');
        //console.log('Rooms persisted to', ROOMS_FILE);
    } catch (e) {
        console.warn('Failed to save rooms:', e.message);
    }
}

process.on('exit', () => saveRooms());
process.on('SIGINT', () => { saveRooms(); process.exit(); });
process.on('SIGTERM', () => { saveRooms(); process.exit(); });

// Load on startup
loadRooms();

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);
    // Set default username and media state; room will be set when user joins
    users[socket.id] = { username: 'Anonymous', peerId: null, mediaState: { audio: false, video: false }, room: null };

    // Handle Peer ID registration (for WebRTC)
    socket.on('register-peer', (peerId) => {
        if (users[socket.id]) {
            users[socket.id].peerId = peerId;
            broadcastUsersList(users[socket.id].room);
            console.log(`User ${socket.id} registered peer ID: ${peerId}`);
        }
    });

    // Join a room (create if missing)
    socket.on('join-room', ({ roomId, username }) => {
        if (!roomId) return;
        roomId = String(roomId);
        socket.join(roomId);

        // Create room if not exists
        if (!rooms[roomId]) {
            rooms[roomId] = {
                currentVideo: { platform: 'youtube', id: 'dQw4w9WgXcQ' },
                playlist: [],
                queue: [],
                users: {},
                speakingUsers: new Set(),
                ownerId: null,
                ownerName: null
            };
            console.log('Created room', roomId);
            scheduleSaveRooms();
        }

        // Set user room and username
        users[socket.id].room = roomId;
        if (username) users[socket.id].username = username;

        // If payload says owner, set room owner
        // The event handler's first argument is the payload object
        const payload = arguments[0] || {};
        if (payload && payload.owner) {
            rooms[roomId].ownerId = socket.id;
            rooms[roomId].ownerName = users[socket.id].username || payload.username || 'Owner';
        }
        // Add to room users map
        rooms[roomId].users[socket.id] = users[socket.id];

        // Send current room state to the joining socket
        socket.emit('video-change', rooms[roomId].currentVideo);
        socket.emit('playlist-update', rooms[roomId].playlist);
        socket.emit('queue-update', rooms[roomId].queue);

        // Broadcast updated users list to the room
        broadcastUsersList(roomId);

        console.log(`Socket ${socket.id} joined room ${roomId} as ${users[socket.id].username}`);
    });

    // Handle Username Change
    socket.on('set-username', (username) => {
        if (users[socket.id]) {
            users[socket.id].username = username;
        }
        broadcastUsersList(users[socket.id].room);
        console.log(`User ${socket.id} set username to: ${username}`);
    });

    // Handle media state changes for audio/video join flow
    socket.on('set-media-state', (mediaState) => {
        if (users[socket.id]) {
            users[socket.id].mediaState = {
                audio: !!mediaState?.audio,
                video: !!mediaState?.video,
            };
            const roomId = users[socket.id].room;
            if (roomId && rooms[roomId]) {
                rooms[roomId].users[socket.id] = users[socket.id];
            }
            broadcastUsersList(users[socket.id].room);
        }
    });

    // Handle Text Chat
    socket.on('chat-message', (data) => {
        const userInfo = users[socket.id] || {};
        const username = userInfo.username || 'Anonymous';
        const roomId = userInfo.room;
        if (roomId) {
            io.to(roomId).emit('chat-message', { username: username, text: data.text || data });
        }
    });

    // Handle YouTube Video Sync
    socket.on('video-change', (videoData) => {
        const roomId = users[socket.id]?.room;
        if (!roomId || !rooms[roomId]) return;
        // Handle both old format (string) and new format (object)
        if (typeof videoData === 'string') {
            rooms[roomId].currentVideo = { platform: 'youtube', id: videoData };
        } else {
            rooms[roomId].currentVideo = videoData;
        }
        // If the current video matches the front of the queue, remove it
        const queueRef = rooms[roomId].queue;
        const currentVideoRef = rooms[roomId].currentVideo;
        if (queueRef.length > 0 && queueRef[0].platform === currentVideoRef.platform && queueRef[0].id === currentVideoRef.id) {
            queueRef.shift();
            io.to(roomId).emit('queue-update', queueRef);
        }
        io.to(roomId).emit('video-change', rooms[roomId].currentVideo);
        scheduleSaveRooms();
    });

    // Queue management: add / remove / move / request-next
    socket.on('queue-add', (item) => {
        const roomId = users[socket.id]?.room;
        if (!roomId || !rooms[roomId]) return;
        if (item && item.id) {
            rooms[roomId].queue.push(item);
            io.to(roomId).emit('queue-update', rooms[roomId].queue);
            scheduleSaveRooms();
            console.log(`Queue added in room ${roomId} by ${socket.id}: ${item.platform}:${item.id}`);
        }
    });

    socket.on('queue-remove', (index) => {
        const roomId = users[socket.id]?.room;
        if (!roomId || !rooms[roomId]) return;
        const q = rooms[roomId].queue;
        if (typeof index === 'number' && index >= 0 && index < q.length) {
            q.splice(index, 1);
            io.to(roomId).emit('queue-update', q);
            scheduleSaveRooms();
            console.log(`Queue item removed in room ${roomId} by ${socket.id} at index ${index}`);
        }
    });

    socket.on('queue-move', ({ from, to }) => {
        const roomId = users[socket.id]?.room;
        if (!roomId || !rooms[roomId]) return;
        const q = rooms[roomId].queue;
        if (typeof from === 'number' && typeof to === 'number' && from >= 0 && from < q.length && to >= 0 && to < q.length) {
            const [item] = q.splice(from, 1);
            q.splice(to, 0, item);
            io.to(roomId).emit('queue-update', q);
            scheduleSaveRooms();
            console.log(`Queue item moved in room ${roomId} by ${socket.id} from ${from} to ${to}`);
        }
    });

    socket.on('request-next', () => {
        const roomId = users[socket.id]?.room;
        if (!roomId || !rooms[roomId]) return;
        const q = rooms[roomId].queue;
        if (q.length > 0) {
            const next = q.shift();
            rooms[roomId].currentVideo = { platform: next.platform || 'youtube', id: next.id };
            io.to(roomId).emit('queue-update', q);
            io.to(roomId).emit('video-change', rooms[roomId].currentVideo);
            scheduleSaveRooms();
            console.log(`Advancing to next queue item in ${roomId}: ${rooms[roomId].currentVideo.platform}:${rooms[roomId].currentVideo.id}`);
        }
    });

    // Handle Playlist Updates
    socket.on('playlist-update', (newPlaylist) => {
        const roomId = users[socket.id]?.room;
        if (!roomId || !rooms[roomId]) return;
        rooms[roomId].playlist = newPlaylist;
        io.to(roomId).emit('playlist-update', rooms[roomId].playlist);
        scheduleSaveRooms();
        console.log(`User ${socket.id} updated playlist in ${roomId}. Items: ${newPlaylist.length}`);
    });

    // Handle speaking status
    socket.on('speaking', (isSpeaking) => {
        const roomId = users[socket.id]?.room;
        if (!roomId || !rooms[roomId]) return;
        if (isSpeaking) {
            rooms[roomId].speakingUsers.add(socket.id);
        } else {
            rooms[roomId].speakingUsers.delete(socket.id);
        }
        io.to(roomId).emit('speaking-status', Array.from(rooms[roomId].speakingUsers).map(id => rooms[roomId].users[id]?.username || 'Anonymous'));
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        const roomId = users[socket.id]?.room;
        if (roomId && rooms[roomId]) {
            rooms[roomId].speakingUsers.delete(socket.id);
            delete rooms[roomId].users[socket.id];
            // If room is empty, optionally delete it
            if (Object.keys(rooms[roomId].users).length === 0) {
                delete rooms[roomId];
                scheduleSaveRooms();
                console.log('Deleted empty room', roomId);
            } else {
                broadcastUsersList(roomId);
            }
        }
        delete users[socket.id];
    });
});

// Broadcast the list of users to all connected clients
function broadcastUsersList(roomId) {
    if (!roomId) {
        // Broadcast nothing if room not specified
        return;
    }
    const room = rooms[roomId];
    if (!room) return;
    const usersArray = Object.entries(room.users).map(([socketId, u]) => ({
        id: socketId,
        username: u.username,
        peerId: u.peerId,
        mediaState: u.mediaState || { audio: false, video: false },
        owner: room.ownerId === socketId
    }));
    io.to(roomId).emit('users-list', usersArray);
}

// Glitch uses process.env.PORT to assign dynamic ports
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Hangout running on port ${PORT}`);
});