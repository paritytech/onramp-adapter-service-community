import { describe, expect, it } from 'vitest';

import { probePersonhoodNetworks } from '../../src/startup.js';
import type { PersonhoodNetwork } from '../../src/personhood.js';

const COMMITMENT = '0x' + '11'.repeat(768);
const IDENTIFIER = '0x' + '22'.repeat(32);
const LITE = '0x' + '33'.repeat(32);

/**
 * A network whose `commitment` answers from `roots`, keyed by identifier. A key mapped to `null`
 * is a collection the chain serves nothing for; a key mapped to an `Error` is a read that failed.
 */
function network(
  id: string,
  roots: Record<string, string | null | Error>,
  identifiers: string[] = Object.keys(roots),
): PersonhoodNetwork {
  return {
    id,
    commitments: {
      commitment: async (identifier: string) => {
        const answer = roots[identifier];
        if (answer instanceof Error) throw answer;
        return answer ?? null;
      },
    },
    rings: identifiers.map((identifier) => ({ identifier, exponent: 9 })),
  };
}

const silent = () => {
  /* the probe's log is asserted only where a test is about it */
};

/**
 * The boot probe.
 *
 * What it exists to convert is a specific, expensive failure: a People RPC pointed at the wrong
 * chain, or a collection identifier pasted under the wrong network, refuses every proof while the
 * pod stays green. These tests are about which misconfigurations are worth refusing a boot for and,
 * just as much, which are not.
 */
describe('probePersonhoodNetworks', () => {
  it('accepts a network whose collection has a root', async () => {
    await expect(
      probePersonhoodNetworks([network('previewnet', { [IDENTIFIER]: COMMITMENT })], silent),
    ).resolves.toBeUndefined();
  });

  it('accepts a network where only one of its collections has a root', async () => {
    // The live shape on previewnet and polkadot-test: `people-lite` carries a root and `people`
    // does not. Requiring every collection to answer would refuse the deployment this repo runs.
    await expect(
      probePersonhoodNetworks(
        [network('previewnet', { [LITE]: COMMITMENT, [IDENTIFIER]: null })],
        silent,
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses a boot when a reachable network answers for none of its collections', async () => {
    // Reachable and empty is not an outage. It is a wrong chain or a wrong identifier, and every
    // proof against it would be refused as `UnknownRing`.
    await expect(
      probePersonhoodNetworks([network('polkadot-test', { [IDENTIFIER]: null })], silent),
    ).rejects.toThrow(/'polkadot-test' answered for none of their configured collections/);
  });

  it('names every dead network, not just the first, so one boot fixes them all', async () => {
    await expect(
      probePersonhoodNetworks(
        [
          network('previewnet', { [IDENTIFIER]: null }),
          network('paseo-next-v2', { [IDENTIFIER]: COMMITMENT }),
          network('polkadot-test', { [IDENTIFIER]: null }),
        ],
        silent,
      ),
    ).rejects.toThrow(/'previewnet', 'polkadot-test'/);
  });

  it('lets an unreachable network through, because an outage is not a verdict', async () => {
    // Treating a failed read as "wrong chain" would turn a People-chain blip into a restart loop.
    // The honest cost is that its redeems fail as 503 until it answers, which is loud on its own.
    const logged: string[] = [];
    await expect(
      probePersonhoodNetworks(
        [network('previewnet', { [IDENTIFIER]: new Error('socket hang up') })],
        (m) => logged.push(m),
      ),
    ).resolves.toBeUndefined();
    expect(logged.join('\n')).toMatch(/'previewnet' was unreachable/);
  });

  it('still refuses a network that answered on one collection and errored on another', async () => {
    // A read that came back is evidence about the chain. One `None` plus one failure is a network
    // that demonstrably serves nothing this deployment declared, so the failure does not excuse it.
    await expect(
      probePersonhoodNetworks(
        [network('previewnet', { [LITE]: null, [IDENTIFIER]: new Error('timeout') })],
        silent,
      ),
    ).rejects.toThrow(/'previewnet'/);
  });

  it('stops reading a network as soon as one collection answers', async () => {
    const asked: string[] = [];
    const probe: PersonhoodNetwork = {
      id: 'previewnet',
      commitments: {
        commitment: async (identifier: string) => {
          asked.push(identifier);
          return COMMITMENT;
        },
      },
      rings: [LITE, IDENTIFIER].map((identifier) => ({ identifier, exponent: 9 })),
    };

    await probePersonhoodNetworks([probe], silent);
    expect(asked).toEqual([LITE]);
  });

  it('accepts an empty list, which is what `insecure_dev` reaches this with', async () => {
    await expect(probePersonhoodNetworks([], silent)).resolves.toBeUndefined();
  });
});
