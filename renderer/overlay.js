const { ipcRenderer } = require('electron');

const dot = document.getElementById('dot');
const btn = document.getElementById('btn');
const markBtn = document.getElementById('mark-btn');

btn.addEventListener('click', () => {
  ipcRenderer.send('hk:overlay-toggle');
});

markBtn.addEventListener('click', () => {
  ipcRenderer.send('hk:overlay-mark');
  markBtn.classList.remove('flash');
  void markBtn.offsetWidth; // restart animation
  markBtn.classList.add('flash');
});

ipcRenderer.on('hk:state', (event, { recording }) => {
  dot.classList.toggle('recording', recording);
});
