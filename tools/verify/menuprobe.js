/* Does the app menu's own text say VidGrab, even though macOS insists the bold
   title comes from the bundle? Prints what buildMenu() actually produces. Runs
   with default userData so it cannot collide with the app's single-instance
   lock. */
const { app, Menu } = require('electron');
app.setName('VidGrab');
app.whenReady().then(() => {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'Edit', submenu: [{ role: 'selectAll' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  const m = Menu.getApplicationMenu();
  console.log('app.getName():', app.getName());
  console.log('first submenu label:', m.items[0] && m.items[0].label);
  const sub = (m.items[0] && m.items[0].submenu) || { items: [] };
  console.log('its items:', sub.items.slice(0, 6).map((i) => i.label || '(sep)').join(' | '));
  app.exit(0);
});
