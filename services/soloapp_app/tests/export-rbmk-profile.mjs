// Keep the server's command schema and reset state identical to the browser.
import { writeFileSync } from 'node:fs';
import { RBMK_CONTROLS } from '../public/client/rbmk-data.js';
import { RbmkModel } from '../public/client/rbmk-model.js';
writeFileSync(
  new URL('../src/data/rbmk-profile.json', import.meta.url),
  JSON.stringify(
    {
      controls: RBMK_CONTROLS,
      optionOrder: Object.fromEntries(
        Object.entries(RBMK_CONTROLS)
          .filter(([, schema]) => schema.type === 'select')
          .map(([name, schema]) => [name, Object.keys(schema.options)]),
      ),
      initial: new RbmkModel().snapshot(),
    },
    null,
    2,
  ) + '\n',
);
