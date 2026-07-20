const { ipcRenderer } = require('electron');

const dot = document.getElementById('dot');
const btn = document.getElementById('btn');

btn.addEventListener('click', () => {
  ipcRenderer.send('hk:overlay-toggle');
});

ipcRenderer.on('hk:state', (event, { recording }) => {
  dot.classList.toggle('recording', recording);
});
