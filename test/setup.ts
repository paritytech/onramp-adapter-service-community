import { AssetCatalog, installCatalog } from '../src/meld/catalog.js';

import { TEST_ASSETS } from './fixtures.js';

// Every code lookup reads the catalog `startup.ts` installs at boot; most suites never boot.
installCatalog(new AssetCatalog(TEST_ASSETS));
