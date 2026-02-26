console.log("Frontend script loaded");

const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const sendChatBtn = document.getElementById('send-chat');

if (window.socket) {
  window.socket.on('message', (msg) => {
    if (chatMessages) {
      const msgDiv = document.createElement('div');
      msgDiv.textContent = msg;
      chatMessages.appendChild(msgDiv);
      // Tự động cuộn xuống cuối khi có tin nhắn mới
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  });
}

if (sendChatBtn && chatInput) {
  sendChatBtn.addEventListener('click', () => {
    const msg = chatInput.value.trim();
    if (msg && window.roomName) {
      window.socket.emit('chatMessage', { room: window.roomName, message: msg });
      chatInput.value = '';
    } else if (!window.roomName) {
      alert("Vui lòng vào phòng trước khi chat!");
    }
  });
  chatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendChatBtn.click(); });
}

const endGameBtn = document.getElementById('endGameBtn');

if (endGameBtn) {
  endGameBtn.addEventListener('click', () => {
    const message = "Bạn có chắc chắn muốn kết thúc ván đấu ngay lập tức không?\n\n" +
                    "Lưu ý: Toàn bộ tiền cược hiện tại trong Pot sẽ được hoàn trả lại cho người chơi.";
    
    if (window.confirm(message)) {
      // Gửi yêu cầu kết thúc ván lên server. 
      // Đảm bảo biến roomName đã được định nghĩa khi bạn tham gia phòng.
      window.socket.emit('endGame', window.roomName || null); 
    }
  });
}
