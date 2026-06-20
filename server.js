const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve frontend files from the 'Public' directory
app.use(express.static('Public'));

let currentVideo = { platform: 'youtube', id: 'dQw4w9WgXcQ' }; // Default video
let playlist = []; // Shared playlist for all users
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
        io.emit('video-change', currentVideo); 
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
    const usersList = Object.values(users).map(u => u.username);
    io.emit('users-list', usersList);
}

// Glitch uses process.env.PORT to assign dynamic ports
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Hangout running on port ${PORT}`);
});