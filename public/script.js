// DOM Elements
const statusCard = document.getElementById('statusCard');
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const qrContainer = document.getElementById('qrContainer');
const qrCode = document.getElementById('qrCode');
const controls = document.getElementById('controls');
const readButton = document.getElementById('readButton');
const deleteCheckbox = document.getElementById('deleteCheckbox');
const groupNameInput = document.getElementById('groupNameInput');
const groupSuggestions = document.getElementById('groupSuggestions');
const currentGroup = document.getElementById('currentGroup');
const downloadButton = document.getElementById('downloadButton');
const messagesContainer = document.getElementById('messagesContainer');
const messagesList = document.getElementById('messagesList');
const messageCount = document.getElementById('messageCount');
const messageLimitInput = document.getElementById('messageLimitInput');
const sinceDateInput = document.getElementById('sinceDateInput');
const loadingOverlay = document.getElementById('loadingOverlay');

// Check status periodically
const checkStatus = async () => {
    try {
        const response = await fetch('/status');
        const data = await response.json();

        if (data.authenticated) {
            // Authenticated - show controls
            statusText.textContent = '✅ Connected to WhatsApp';
            statusIndicator.querySelector('.status-dot').className = 'status-dot connected';
            qrContainer.style.display = 'none';
            controls.style.display = 'block';

            // Update current group display
            if (data.currentGroupName) {
                currentGroup.textContent = data.currentGroupName;
            }

            // Populate available groups dropdown
            if (data.availableGroups && data.availableGroups.length > 0) {
                groupSuggestions.innerHTML = '';
                data.availableGroups.forEach(group => {
                    const option = document.createElement('option');
                    option.value = group;
                    groupSuggestions.appendChild(option);
                });
            }
        } else if (data.qrCode) {
            // Show QR code
            statusText.textContent = '⏳ Waiting for QR scan...';
            statusIndicator.querySelector('.status-dot').className = 'status-dot waiting';
            qrContainer.style.display = 'block';
            controls.style.display = 'none';

            // Generate QR code
            qrCode.innerHTML = '';
            try {
                new QRCode(qrCode, {
                    text: data.qrCode,
                    width: 256,
                    height: 256,
                    colorDark: "#000000",
                    colorLight: "#ffffff",
                    correctLevel: QRCode.CorrectLevel.H
                });
            } catch (error) {
                console.error('QR code generation error:', error);
                qrCode.innerHTML = '<p style="color: red;">Error generating QR code. Please refresh the page.</p>';
            }
        } else {
            // Initializing
            statusText.textContent = '🔄 Initializing...';
            statusIndicator.querySelector('.status-dot').className = 'status-dot';
            qrContainer.style.display = 'none';
            controls.style.display = 'none';
        }
    } catch (error) {
        console.error('Error checking status:', error);
        statusText.textContent = '❌ Connection error';
        statusIndicator.querySelector('.status-dot').className = 'status-dot disconnected';
    }
};

// Read messages
const readMessages = async () => {
    try {
        loadingOverlay.style.display = 'flex';
        readButton.disabled = true;

        const groupName = groupNameInput.value.trim() || 'GP read';

        const requestBody = {
            deleteMessages: deleteCheckbox.checked,
            groupName: groupName,
            messageLimit: parseInt(messageLimitInput.value) || 10
        };

        // Add optional since date filter
        if (sinceDateInput.value) {
            requestBody.sinceDate = new Date(sinceDateInput.value).toISOString();
        }

        const response = await fetch('/read-messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        const data = await response.json();

        if (data.success) {
            // Update current group display
            if (data.groupName) {
                currentGroup.textContent = data.groupName;
            }

            // Display messages
            messagesList.innerHTML = '';
            messageCount.textContent = `${data.count} messages`;

            if (data.messages.length > 0) {
                data.messages.forEach(msg => {
                    const messageItem = document.createElement('div');
                    messageItem.className = 'message-item';
                    messageItem.innerHTML = `
                        <div class="message-sender">${escapeHtml(msg.sender)}</div>
                        <div class="message-timestamp">${escapeHtml(msg.timestamp)}</div>
                        <div class="message-text">${escapeHtml(msg.message)}</div>
                    `;
                    messagesList.appendChild(messageItem);
                });
                messagesContainer.style.display = 'block';
            } else {
                messagesList.innerHTML = '<p style="text-align: center; color: #94a3b8; padding: 20px;">No messages found</p>';
                messagesContainer.style.display = 'block';
            }

            // Show success notification
            showNotification('✅ Messages retrieved successfully!', 'success');
        } else {
            showNotification('❌ Error: ' + data.error, 'error');
        }
    } catch (error) {
        console.error('Error reading messages:', error);
        showNotification('❌ Failed to read messages', 'error');
    } finally {
        loadingOverlay.style.display = 'none';
        readButton.disabled = false;
    }
};

// Download log file
const downloadLog = () => {
    window.location.href = '/download-log';
};

// Helper function to escape HTML
const escapeHtml = (text) => {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
};

// Show notification
const showNotification = (message, type) => {
    const notification = document.createElement('div');
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 16px 24px;
        background: ${type === 'success' ? '#22c55e' : '#ef4444'};
        color: white;
        border-radius: 12px;
        font-weight: 600;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
        z-index: 2000;
        animation: slideInRight 0.3s ease-out;
    `;
    document.body.appendChild(notification);

    setTimeout(() => {
        notification.style.animation = 'fadeOut 0.3s ease-out';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
};

// Event listeners
readButton.addEventListener('click', readMessages);
downloadButton.addEventListener('click', downloadLog);

// Initial status check
checkStatus();

// Check status every 3 seconds
setInterval(checkStatus, 3000);

// Add animations CSS
const style = document.createElement('style');
style.textContent = `
    @keyframes slideInRight {
        from {
            transform: translateX(400px);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }
    
    @keyframes fadeOut {
        to {
            opacity: 0;
            transform: translateY(-20px);
        }
    }
`;
document.head.appendChild(style);
