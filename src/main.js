import { Actor, log } from 'apify';
import { sanitize } from './noaa.js';
import { runActor } from './run.js';

await Actor.init();

try {
    const count = await runActor((await Actor.getInput()) ?? {}, {
        actor: Actor,
        warn: (message) => log.warning(message),
    });
    log.info(`Done. Pushed ${count} station-day records.`);
} catch (error) {
    await Actor.fail(sanitize(error?.message ?? error));
}

await Actor.exit();
