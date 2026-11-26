import { pathToFileURL } from 'node:url';
import { createSciDeveloperApp } from './app.js';

export { createSciDeveloperApp } from './app.js';

async function main() {
  const workbench = createSciDeveloperApp({
    dataDir: process.env.SCIDEV_DATA_DIR || undefined,
    skillsDir: process.env.SCIDEV_SKILLS_DIR || undefined,
    workspaceRoot: process.env.SCIDEV_WORKSPACE_ROOT || undefined,
    webDistDir: process.env.SCIDEV_WEB_DIST_DIR || undefined,
  });
  // The vault has loaded its master key. Keep it out of inherited compute environments.
  delete process.env.SCIDEV_VAULT_KEY;
  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    void workbench.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('Could not close SciDeveloper', error);
        process.exit(1);
      },
    );
  }

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  if (process.connected) process.once('disconnect', stop);

  try {
    const { url } = await workbench.start(Number(process.env.PORT ?? 4318));
    if (!stopping) console.log('SciDeveloper listening at ' + url);
  } catch (error) {
    if (stopping) return;
    process.removeListener('disconnect', stop);
    if (process.connected) process.disconnect?.();
    await workbench.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error('Could not start SciDeveloper', error);
    process.exitCode = 1;
  });
}
