const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve frontend files from the 'Public' directory
app.use(express.static('Public'));

// Serve local client libraries from node_modules to avoid external CDN/blocking issues
app.use('/js/peerjs', express.static(path.join(__dirname, 'node_modules', 'peerjs', 'dist')));
app.use('/js/socket.io', express.static(path.join(__dirname, 'node_modules', 'socket.io', 'client-dist')));

let currentVideo = { platform: 'youtube', id: 'dQw4w9WgXcQ' }; // Default video
let playlist = []; // Shared playlist for all users
let queue = []; // Shared video queue
let users = {}; // Track users: { socketId: { username, peerId } }
let speakingUsers = new Set(); // Track who's currently speaking

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);
    
    // Set default username
    users[socket.id] = { username: 'Anonymous', peerId: null };
    broadcastUsersList();

    // Send the current video to the new user immediately
    socket.emit('video-change', currentVideo);

    // Send the current playlist to the new user
    socket.emit('playlist-update', playlist);
    // Send the current queue to the new user
    socket.emit('queue-update', queue);

    // Handle Peer ID registration (for WebRTC)
    socket.on('register-peer', (peerId) => {
        if (users[socket.id]) {
            users[socket.id].peerId = peerId;
            broadcastUsersList();
            console.log(`User ${socket.id} registered peer ID: ${peerId}`);
        }
    });

    // Handle Username Change
    socket.on('set-username', (username) => {
        if (users[socket.id]) {
            users[socket.id].username = username;
        }
        broadcastUsersList();
        console.log(`User ${socket.id} set username to: ${username}`);
    });

    // Handle Text Chat
    socket.on('chat-message', (data) => {
        const userInfo = users[socket.id] || {};
        const username = userInfo.username || 'Anonymous';
        io.emit('chat-message', { username: username, text: data.text || data }); 
    });

    // Handle YouTube Video Sync
    socket.on('video-change', (videoData) => {
        // Handle both old format (string) and new format (object)
        if (typeof videoData === 'string') {
            currentVideo = { platform: 'youtube', id: videoData };
        } else {
            currentVideo = videoData;
        }
        // If the current video matches the front of the queue, remove it
        if (queue.length > 0 && queue[0].platform === currentVideo.platform && queue[0].id === currentVideo.id) {
            queue.shift();
            io.emit('queue-update', queue);
        }
        io.emit('video-change', currentVideo); 
    });

    // Queue management: add / remove / move / request-next
    socket.on('queue-add', (item) => {
        // item: { platform, id, title, requestedBy }
        if (item && item.id) {
            queue.push(item);
            io.emit('queue-update', queue);
            console.log(`Queue added by ${socket.id}: ${item.platform}:${item.id}`);
        }
    });

    socket.on('queue-remove', (index) => {
        if (typeof index === 'number' && index >= 0 && index < queue.length) {
            queue.splice(index, 1);
            io.emit('queue-update', queue);
            console.log(`Queue item removed by ${socket.id} at index ${index}`);
        }
    });

    socket.on('queue-move', ({ from, to }) => {
        if (typeof from === 'number' && typeof to === 'number' && from >= 0 && from < queue.length && to >= 0 && to < queue.length) {
            const [item] = queue.splice(from, 1);
            queue.splice(to, 0, item);
            io.emit('queue-update', queue);
            console.log(`Queue item moved by ${socket.id} from ${from} to ${to}`);
        }
    });

    socket.on('request-next', () => {
        if (queue.length > 0) {
            const next = queue.shift();
            currentVideo = { platform: next.platform || 'youtube', id: next.id };
            io.emit('queue-update', queue);
            io.emit('video-change', currentVideo);
            console.log(`Advancing to next queue item: ${currentVideo.platform}:${currentVideo.id}`);
        }
    });

    // Handle Playlist Updates
    socket.on('playlist-update', (newPlaylist) => {
        playlist = newPlaylist;
        io.emit('playlist-update', playlist);
        console.log(`User ${socket.id} updated playlist. Items: ${playlist.length}`);
    });

    // Handle speaking status
    socket.on('speaking', (isSpeaking) => {
        if (isSpeaking) {
            speakingUsers.add(socket.id);
        } else {
            speakingUsers.delete(socket.id);
        }
        io.emit('speaking-status', Array.from(speakingUsers).map(id => users[id]?.username || 'Anonymous'));
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        speakingUsers.delete(socket.id);
        delete users[socket.id];
        broadcastUsersList();
    });
});

// Broadcast the list of users to all connected clients
function broadcastUsersList() {
    const usersArray = Object.values(users).map(u => ({ username: u.username, peerId: u.peerId }));
    io.emit('users-list', usersArray);
}

// Glitch uses process.env.PORT to assign dynamic ports
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Hangout running on port ${PORT}`);
});