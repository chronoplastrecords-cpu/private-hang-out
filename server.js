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
// Avatar upload limits
const MAX_AVATAR_BYTES = 200 * 1024; // 200 KB
const ALLOWED_AVATAR_MIME = ['image/png', 'image/jpeg'];
let sharp = null;
try {
    sharp = require('sharp');
} catch (e) {
    console.info('`sharp` not available — avatar auto-resize disabled. Install sharp to enable resizing.');
}

// Serve frontend files from the 'Public' directory
app.use(express.static('Public'));

// Serve local client libraries from node_modules to avoid external CDN/blocking issues
app.use('/js/peerjs', express.static(path.join(__dirname, 'node_modules', 'peerjs', 'dist')));
app.use('/js/socket.io', express.static(path.join(__dirname, 'node_modules', 'socket.io', 'client-dist')));
// Serve uploaded avatars
const UPLOADS_DIR = path.join(__dirname, 'Public', 'uploads');
app.use('/uploads', express.static(UPLOADS_DIR));

// Ensure uploads directory exists
try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch (e) { /* ignore */ }

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
            console.info('Loaded persisted rooms from', ROOMS_FILE);
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
    console.info('User connected:', socket.id);
    // Set default username and media state; room will be set when user joins
    users[socket.id] = { username: 'Anonymous', peerId: null, mediaState: { audio: false, video: false }, room: null };

    // Handle Peer ID registration (for WebRTC)
    socket.on('register-peer', (peerId) => {
        if (users[socket.id]) {
            users[socket.id].peerId = peerId;
            broadcastUsersList(users[socket.id].room);
            console.debug(`User ${socket.id} registered peer ID: ${peerId}`);
        }
    });

    // Handle avatar upload (dataURL) via socket with validation and optional resizing
    socket.on('upload-avatar', async (dataUrl) => {
        try {
            if (!dataUrl || typeof dataUrl !== 'string') {
                socket.emit('avatar-upload-error', 'Invalid image data');
                return;
            }
            const matches = dataUrl.match(/^data:(image\/(png|jpeg|jpg));base64,(.+)$/);
            if (!matches) {
                socket.emit('avatar-upload-error', 'Unsupported image format. Only PNG and JPEG allowed.');
                return;
            }
            const mime = matches[1];
            if (!ALLOWED_AVATAR_MIME.includes(mime)) {
                socket.emit('avatar-upload-error', 'Unsupported image MIME type.');
                return;
            }
            const ext = matches[2] === 'jpeg' ? 'jpg' : matches[2];
            const b64 = matches[3];
            let buf = Buffer.from(b64, 'base64');

            // If too large, attempt to resize/convert using sharp if available
            if (buf.length > MAX_AVATAR_BYTES) {
                if (!sharp) {
                    socket.emit('avatar-upload-error', `Image too large (${Math.round(buf.length/1024)}KB). Max ${Math.round(MAX_AVATAR_BYTES/1024)}KB.`);
                    return;
                }
                try {
                    // Resize to 256x256 cover and convert to JPEG; iteratively reduce quality until under limit
                    let quality = 80;
                    let converted = await sharp(buf).resize(256, 256, { fit: 'cover' }).jpeg({ quality }).toBuffer();
                    while (converted.length > MAX_AVATAR_BYTES && quality > 30) {
                        quality -= 10;
                        converted = await sharp(buf).resize(256, 256, { fit: 'cover' }).jpeg({ quality }).toBuffer();
                    }
                    if (converted.length > MAX_AVATAR_BYTES) {
                        socket.emit('avatar-upload-error', `Could not compress image below ${Math.round(MAX_AVATAR_BYTES/1024)}KB.`);
                        return;
                    }
                    buf = converted;
                    // use jpg extension for converted images
                    const outExt = 'jpg';
                    const filename = `${socket.id}.${outExt}`;
                    const outPath = path.join(UPLOADS_DIR, filename);
                    fs.writeFileSync(outPath, buf);
                    const avatarUrl = `/uploads/${filename}?t=${Date.now()}`;
                    if (users[socket.id]) {
                        users[socket.id].avatar = avatarUrl;
                        const roomId = users[socket.id].room;
                        if (roomId && rooms[roomId]) {
                            if (!rooms[roomId].users) rooms[roomId].users = {};
                            rooms[roomId].users[socket.id] = users[socket.id];
                        }
                    }
                    const roomId = users[socket.id]?.room;
                    if (roomId) broadcastUsersList(roomId);
                    socket.emit('avatar-upload-success', users[socket.id]?.avatar || avatarUrl);
                    console.debug(`User ${socket.id} uploaded avatar (resized): ${avatarUrl}`);
                    return;
                } catch (e) {
                    console.warn('Avatar resize failed:', e.message);
                    socket.emit('avatar-upload-error', 'Server failed to resize image.');
                    return;
                }
            }

            const filename = `${socket.id}.${ext}`;
            const outPath = path.join(UPLOADS_DIR, filename);
            fs.writeFileSync(outPath, buf);

            // Attach avatar URL to user and room entry
            const avatarUrl = `/uploads/${filename}?t=${Date.now()}`;
            if (users[socket.id]) {
                users[socket.id].avatar = avatarUrl;
                const roomId = users[socket.id].room;
                if (roomId && rooms[roomId]) {
                    if (!rooms[roomId].users) rooms[roomId].users = {};
                    rooms[roomId].users[socket.id] = users[socket.id];
                }
            }
            // Broadcast updated users list for the room
            const roomId = users[socket.id]?.room;
            if (roomId) broadcastUsersList(roomId);
            socket.emit('avatar-upload-success', users[socket.id]?.avatar || avatarUrl);
            console.debug(`User ${socket.id} uploaded avatar: ${avatarUrl}`);
        } catch (e) {
            console.warn('Failed to save avatar', e.message);
            socket.emit('avatar-upload-error', 'Server error saving avatar');
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
            console.info('Created room', roomId);
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

        console.debug(`Socket ${socket.id} joined room ${roomId} as ${users[socket.id].username}`);
    });

    // Handle Username Change
    socket.on('set-username', (username) => {
        if (users[socket.id]) {
            users[socket.id].username = username;
        }
        broadcastUsersList(users[socket.id].room);
        console.debug(`User ${socket.id} set username to: ${username}`);
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
            console.debug(`Queue added in room ${roomId} by ${socket.id}: ${item.platform}:${item.id}`);
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
            console.debug(`Queue item removed in room ${roomId} by ${socket.id} at index ${index}`);
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
            console.debug(`Queue item moved in room ${roomId} by ${socket.id} from ${from} to ${to}`);
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
            console.debug(`Advancing to next queue item in ${roomId}: ${rooms[roomId].currentVideo.platform}:${rooms[roomId].currentVideo.id}`);
        }
    });

    // Handle Playlist Updates
    socket.on('playlist-update', (newPlaylist) => {
        const roomId = users[socket.id]?.room;
        if (!roomId || !rooms[roomId]) return;
        rooms[roomId].playlist = newPlaylist;
        io.to(roomId).emit('playlist-update', rooms[roomId].playlist);
        scheduleSaveRooms();
        console.debug(`User ${socket.id} updated playlist in ${roomId}. Items: ${newPlaylist.length}`);
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
        console.info('User disconnected:', socket.id);
        const roomId = users[socket.id]?.room;
        if (roomId && rooms[roomId]) {
            rooms[roomId].speakingUsers.delete(socket.id);
            delete rooms[roomId].users[socket.id];
            // If room is empty, optionally delete it
            if (Object.keys(rooms[roomId].users).length === 0) {
                delete rooms[roomId];
                scheduleSaveRooms();
                console.info('Deleted empty room', roomId);
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
        owner: room.ownerId === socketId,
        avatar: u.avatar || null
    }));
    io.to(roomId).emit('users-list', usersArray);
}

// Glitch uses process.env.PORT to assign dynamic ports
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.info(`Hangout running on port ${PORT}`);
});