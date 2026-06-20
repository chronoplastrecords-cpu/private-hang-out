const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve frontend files from the 'public' directory
app.use(express.static('public'));

let currentVideo = 'dQw4w9WgXcQ'; // Default video

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Send the current video to the new user immediately
    socket.emit('video-change', currentVideo);

    // Handle Text Chat
    socket.on('chat-message', (msg) => {
        io.emit('chat-message', msg); 
    });

    // Handle YouTube Video Sync
    socket.on('video-change', (videoId) => {
        currentVideo = videoId;
        io.emit('video-change', videoId); 
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

// Glitch uses process.env.PORT to assign dynamic ports
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Hangout running on port ${PORT}`);
});