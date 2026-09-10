/**
 * Prove the Helm chart renders, and that what it renders is a config this service accepts.
 *
 * The chart writes `config.json` into a ConfigMap and the process parses it at boot with the
 * zod schema in `src/config.ts`. Nothing connected the two, so the chart could render a config
 * the service refuses and the only place that surfaced was a crash-looping pod. Two real faults
 * were found the first time this ran: `helm template` with default values failed on a nil
 * pointer (`secrets` was declared in the environment overlays but never in `values.yaml`), and
 * the security context set container-only fields on the pod, where Kubernetes silently ignores
 * them.
 *
 * Run: `npm run check:chart` (needs `helm` on PATH and a prior `npm run build`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

// Named import, not default: js-yaml 5 dropped the CommonJS default export, so
// `import yaml from 'js-yaml'` fails at load with "does not provide an export named 'default'".
import { loadAll } from 'js-yaml';

const CHART = 'helm';
/** An overlay carrying this is still awaiting operator values. */
const TEMPLATE_MARKER = 'TODO(operator)';
/**
 * The only fields a template overlay is allowed to be missing, in EVERY overlay.
 *
 * `people_rpc_url` is deliberately NOT here, and putting it back is a mistake worth naming because
 * it has been made twice. While it sat on this list any fault in it was swallowed: matching is by
 * substring across all overlays, so a `ws://attacker.example` in one of them passed this gate
 * green. That URL is the root of trust for personhood: every proof is verified against the
 * commitment read from it, and plaintext means whoever is on the path decides who is a person. An
 * overlay that leaves it empty fails this gate, which is the point: a substring waiver here would
 * also cover the overlay that has it filled.
 */
const EXPECTED_TEMPLATE_HOLES = ['collections', 'trusted_proxy_cidrs'];

/**
 * Schema paths the defaults are expected to fail on for a reason that is not an unfilled hole.
 *
 * `values.yaml` ships `environment: production` beside the sandbox `meld.base_url`, a pairing the
 * schema refuses on purpose so the defaults are never a bootable config (see the comment at the top
 * of `values.yaml`). That is a deliberate fail-closed, not something an operator fills in, so it
 * cannot be expressed as a `REQUIRED_OPERATOR_INPUTS` entry, and it needs a home of its own rather
 * than a widened allow-list.
 */
const DEFAULTS_FAIL_CLOSED = ['meld.base_url'];


/**
 * The closed set of values this repo cannot fill, and who owes each.
 *
 * A `TODO(operator)` is not deferred engineering: every one of these is a value another team
 * supplies, and no amount of work here produces it. What was missing is that nothing said so. The
 * markers were scattered across three files, and a new hole could appear, or a filled one keep its
 * marker, with the build green either way.
 *
 * So the inventory is checked rather than described. Every template overlay is scanned for unfilled
 * values, and the set it yields must match this list exactly. Add a hole without declaring it
 * and the gate fails; fill one and leave it listed and the gate fails. That is the difference
 * between a TODO and a specification of an input.
 *
 * `cors.allowed_origins` is an empty array rather than an empty string, and is checked the same
 * way; it fails closed (every browser refused, every redirect refused) and is the consumer application's.
 */
const REQUIRED_OPERATOR_INPUTS = [
  {
    // The live Polkadot People chain carries no `Members` pallet, so there is no ring to verify
    // against and no endpoint to name; a testnet like paseo-people-next has both. Empty rather
    // than a plausible hostname, because the value that stood here did not resolve at all and
    // read as configured.
    what: 'auth.personhood.people_rpc_url',
    owedBy: 'the People chain you target',
    unfilled: (_output, config) => (config?.auth?.personhood?.people_rpc_url ?? '') === '',
  },
  {
    what: 'auth.personhood.collections',
    owedBy: 'the consumer application',
    // Empty rather than all-zeroes: a zero id is valid 32-byte hex and would boot.
    unfilled: (_output, config) => (config?.auth?.personhood?.collections ?? []).length === 0,
  },
  {
    what: 'cors.allowed_origins',
    owedBy: 'the consumer application',
    // Fails closed: every browser preflight refused, every redirectUrl refused.
    unfilled: (_output, config) => Array.isArray(config?.cors?.allowed_origins) && config.cors.allowed_origins.length === 0,
  },
  {
    what: 'server.trusted_proxy_cidrs',
    owedBy: 'the cluster operator',
    // Empty is accepted and boots: no forwarded header is read, so every caller behind the ingress
    // shares one bucket. This gate is the only thing that reports it as still owed, because a
    // running pod does not.
    unfilled: (_output, config) =>
      Array.isArray(config?.server?.trusted_proxy_cidrs) && config.server.trusted_proxy_cidrs.length === 0,
  },
  {
    what: 'store.authProxy.instance',
    owedBy: 'the cluster operator',
    // Rendered as an empty final argument to the proxy, which refuses to start without one.
    unfilled: (output) => /- name: cloud-sql-proxy[\s\S]*?- ""/.test(output),
  },
  {
    what: 'serviceAccount.annotations["iam.gke.io/gcp-service-account"]',
    owedBy: 'the cluster operator',
    // Without it the proxy cannot authenticate, and the symptom is a database error not an IAM one.
    unfilled: (output) => /iam\.gke\.io\/gcp-service-account:\s*(""|'')\s*$/m.test(output),
  },
];

/**
 * Report which declared inputs an overlay is still waiting on, and refuse an undeclared hole.
 *
 * The check runs against the rendered manifests rather than the values file, so it describes
 * what would actually be deployed. An input that stops being unfilled must leave the list: an
 * inventory that keeps listing something nobody is waiting for is the same drift in the other
 * direction.
 */
function operatorInputsAwaited(label, output, config) {
  const awaited = REQUIRED_OPERATOR_INPUTS.filter((input) => input.unfilled(output, config));
  if (awaited.length === 0) {
    throw new Error(
      `${label} is marked a template but every declared operator input is filled. ` +
        `Remove the "${TEMPLATE_MARKER}" markers so this overlay is validated on every commit.`,
    );
  }
  return awaited;
}
const overlays = readdirSync(CHART).filter((f) => /^values-.*\.yaml$/.test(f));

if (!existsSync('dist/config.js')) {
  console.error('dist/config.js is missing. Run `npm run build` first.');
  process.exit(1);
}
const { parseConfig } = await import('../dist/config.js');

/**
 * `image.tag` is required by the chart and supplied by the deploy pipeline, never by a values
 * file; an empty tag now fails the render rather than falling back to an appVersion the build
 * workflow never publishes. So every render here supplies one, exactly as the pipeline does.
 */
const RENDER_ARGS = ['--set', 'image.tag=dev'];

const helm = (args) => execFileSync('helm', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

/**
 * The Kubernetes version the rendered manifests are validated against.
 *
 * Without it kubeconform resolves schemas from `master` on raw.githubusercontent.com on every
 * run: a network dependency in a gate whose binary is checksum-pinned, flaky when GitHub is slow,
 * and validating against whatever the newest API surface happens to be rather than the one the
 * cluster runs. Pinned so the gate answers the same question every time.
 *
 * TODO(operator): confirm this matches your cluster's minor version and bump it with the cluster.
 */
const KUBERNETES_VERSION = '1.30.0';

/**
 * Validate the rendered manifests as actual Kubernetes objects.
 *
 * Rendering and parsing the config proves the chart produces something and that the app accepts
 * the config inside it. Neither proves the manifest is a legal Deployment; that gap is why a
 * `mountPath: .` had to be caught by a hand-written guard, which only ever catches the one way a
 * value was already known to be wrong. `kubeconform` checks the whole object against the API
 * schemas offline, so the next such mistake is caught generically.
 *
 * Skipped with a warning when the binary is absent, so a local run still works; CI installs it,
 * which is where the gate has to hold.
 */
function validateManifests(output, label) {
  try {
    execFileSync(
      'kubeconform',
      ['-strict', '-summary', '-kubernetes-version', KUBERNETES_VERSION, '-'],
      { input: output, encoding: 'utf8' },
    );
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (!validateManifests.warned) {
        console.warn('kubeconform not on PATH; manifest schema validation skipped (CI installs it).');
        validateManifests.warned = true;
      }
      return;
    }
    throw new Error(`${label}: rendered manifests are not valid Kubernetes objects\n${error.stdout ?? ''}${error.stderr ?? ''}`);
  }
}

/** Pull `config.json` out of the rendered ConfigMap without a YAML dependency. */
function renderedConfig(output) {
  const start = output.indexOf('config.json: |');
  if (start === -1) throw new Error('no config.json in the rendered chart');
  const lines = output.slice(start).split('\n').slice(1);
  const body = [];
  for (const line of lines) {
    if (line.trim() === '' ) { body.push(''); continue; }
    if (!line.startsWith('    ')) break;
    body.push(line.slice(4));
  }
  return JSON.parse(body.join('\n'));
}

/**
 * Every `mode: file` secret in the rendered config must be mounted at exactly that path.
 *
 * The ConfigMap says where the process will look for a credential and the Deployment says where
 * one is put; nothing tied the two together, and a mismatch is not a render error. It is a pod
 * that starts, refuses at `Secret is missing or empty`, and crash-loops. The paths agreeing is
 * the whole reason the secret ever reaches the process.
 */
function secretPathsAreMounted(output, config) {
  const filePaths = [];
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (node.mode === 'file' && typeof node.path === 'string') filePaths.push(node.path);
    for (const value of Object.values(node)) walk(value);
  };
  walk(config);

  const mounted = new Set(
    [...output.matchAll(/mountPath:\s*"?([^"\n]+?)"?\s*$/gm)].map((m) => m[1].trim()),
  );
  const missing = filePaths.filter((path) => !mounted.has(path));
  if (missing.length > 0) {
    throw new Error(
      `config expects secret files at ${missing.join(', ')}, which the deployment does not mount. ` +
        `Mounted: ${[...mounted].join(', ')}`,
    );
  }
  return filePaths.length;
}

/**
 * The field paths a config error names, one per issue.
 *
 * `parseConfig` aggregates every problem into one message, so asking whether a string mentions
 * an expected field cannot tell "only the expected holes" from "the expected holes and four
 * other faults". The per-issue paths can.
 */
function issuePaths(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes(':'))
    .map((line) => line.slice(0, line.indexOf(':')))
    .filter((path) => path.length > 0 && !path.startsWith('Invalid configuration'));
}

helm(['lint', CHART, ...RENDER_ARGS]);
console.log('helm lint: ok');

// Default values must render on their own: a chart that only works with an overlay cannot be
// dry-run, linted or reviewed by anyone who does not already have the overlay.
for (const overlay of [undefined, ...overlays]) {
  const args = [
    'template',
    'check',
    CHART,
    ...(overlay ? ['-f', `${CHART}/${overlay}`] : []),
    ...RENDER_ARGS,
  ];
  const label = overlay ?? 'values.yaml (defaults)';
  const output = helm(args);
  validateManifests(output, label);

  const config = renderedConfig(output);


  // An overlay still carrying operator placeholders cannot parse: the People collection id is
  // theirs to supply. Rather than skipping those, which would let a finished overlay drift
  // unvalidated behind a stale comment, they are asserted to fail, and to fail for that reason
  // only. So a template that quietly becomes deployable turns into a build failure telling you
  // to start validating it, and a template that breaks for some new reason is still caught.
  const isTemplate = readFileSync(`${CHART}/${overlay ?? 'values.yaml'}`, 'utf8').includes(
    TEMPLATE_MARKER,
  );
  if (isTemplate) {
    let parsed = false;
    try {
      parseConfig(config);
      parsed = true;
    } catch (error) {
      // Every issue must be an expected hole, not merely one of them.
      //
      // Asking whether any expected field appears anywhere in the aggregated
      // message, so while `collections` was empty (the state a template overlay ships in), every
      // other schema violation in the same overlay was swallowed. A `trusted_proxy_hops` of 99,
      // which is the rate-limit bypass the README and the ingress template both single out, passed
      // this gate.
      // Matching is by whole path against something proven empty, not by substring against a
      // name. That distinction is the point. While the allow-list was substring-matched, a
      // `people_rpc_url` of `ws://attacker.example` matched the entry meant to excuse an empty
      // one and passed this gate green, and that URL is the root of trust for personhood: every
      // proof is verified against the commitment read from it. A value that is present but wrong
      // is now an unexpected fault, because `unfilled` is false for it.
      const issues = issuePaths(error);
      const declaredEmpty = REQUIRED_OPERATOR_INPUTS.filter((input) =>
        input.unfilled(output, config),
      ).map((input) => input.what);
      const allowed = [
        ...declaredEmpty,
        ...(overlay === undefined ? DEFAULTS_FAIL_CLOSED : []),
        ...EXPECTED_TEMPLATE_HOLES,
      ];
      const unexpected = issues.filter((path) => !allowed.includes(path));
      if (issues.length === 0 || unexpected.length > 0) {
        throw new Error(
          `${label} is marked a template but has faults beyond the operator's holes: ` +
            `${unexpected.join(', ') || 'unparseable'}\n${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (parsed) {
      throw new Error(
        `${label} now renders a valid config, so it is no longer a template. ` +
          `Remove the "${TEMPLATE_MARKER}" markers so this overlay is validated on every commit.`,
      );
    }
    // The defaults deliberately mount nothing: no secrets exist to name until an overlay names
    // them, so asserting the mounts here would assert the absence of the very thing an operator
    // adds. The holes above are what the defaults are checked for.
    if (overlay !== undefined) secretPathsAreMounted(output, config);
    const awaited = operatorInputsAwaited(label, output, config);
    console.log(
      `${label}: renders, awaiting ${String(awaited.length)} operator input(s): ` +
        awaited.map((i) => `${i.what} (${i.owedBy})`).join('; '),
    );
    continue;
  }

  parseConfig(config);
  const secrets = secretPathsAreMounted(output, config);
  console.log(`${label}: renders, the config parses, and its ${secrets} secret path(s) are mounted`);
}

// The NetworkPolicy template renders nothing under the defaults (`networkPolicy.enabled: false`),
// so nothing above exercises it; a template bug (like the original `index .cidrs 0` that dropped
// every CIDR after the first) would sail through the gate unvalidated.
//
// Rendered in both store shapes, because the egress the database needs differs between them and
// each is a config an operator can choose. The proxy shape was added to the template and then not
// rendered here at all: `store.authProxy.enabled` defaults to false, so the rules for it, and the
// guard that refuses without their CIDRs, were absent from the only render this gate inspected.
// Contents that are never rendered are contents this gate cannot count.
const NETPOL_PEERS = [
  '--set',
  'networkPolicy.enabled=true',
  '--set-json',
  'networkPolicy.ingressControllerNamespaces=["ingress-nginx"]',
  '--set-json',
  'networkPolicy.peers.peopleChain.namespaces=["people-chain"]',
  '--set-json',
  'networkPolicy.peers.peopleChain.cidrs=["10.0.0.0/24","192.168.0.0/16"]',
  '--set-json',
  'networkPolicy.peers.meld.namespaces=["meld-infra"]',
  '--set-json',
  'networkPolicy.peers.meld.cidrs=["10.1.0.0/24","172.16.0.0/12"]',
];

/** The peers plus the database CIDR every shape needs: the minimum that renders at all. */
const NETPOL_BASE = [...NETPOL_PEERS, '--set-json', 'networkPolicy.peers.cloudsql.instanceCidrs=["10.3.0.0/24"]'];

/**
 * Assert the structure of a rendered NetworkPolicy.
 *
 * Parsed, not pattern-matched. The previous version counted objects and grepped two strings, and
 * nine of sixteen mutations walked past it, including `ingress: [- {}]`, which permits every pod
 * on every port and is the whole hole this template exists to close. It printed its success line
 * verbatim against that render. Mirroring YAML semantics with regular expressions is the same
 * mistake as mirroring a CIDR grammar with one: the structure decides the meaning.
 */
function checkNetworkPolicy(label, output, expectedPorts) {
  validateManifests(output, label);
  const docs = loadAll(output).filter((d) => d !== null && d !== undefined);
  const policies = docs.filter((d) => d.kind === 'NetworkPolicy');
  if (policies.length !== 1) {
    throw new Error(`${label}: expected exactly 1 NetworkPolicy (ingress + egress in one object), got ${policies.length}`);
  }
  const spec = policies[0].spec ?? {};

  for (const type of ['Ingress', 'Egress']) {
    if (!(spec.policyTypes ?? []).includes(type)) {
      throw new Error(`${label}: policyTypes is missing ${type}, so that direction is unrestricted`);
    }
  }

  // A policy selecting nothing renders clean, validates clean, and protects nothing.
  const podLabels = spec.podSelector?.matchLabels ?? {};
  if (Object.keys(podLabels).length === 0) {
    throw new Error(`${label}: podSelector.matchLabels is empty, so the policy captures every pod in the namespace`);
  }
  const templateLabels = docs.find((d) => d.kind === 'Deployment')?.spec?.template?.metadata?.labels ?? {};
  for (const [k, v] of Object.entries(podLabels)) {
    if (templateLabels[k] !== v) {
      throw new Error(
        `${label}: podSelector wants ${k}=${String(v)} but the Deployment's pods carry ` +
          `${k}=${String(templateLabels[k])}, so the policy would select no pod`,
      );
    }
  }

  const ingress = spec.ingress ?? [];
  if (ingress.length === 0) throw new Error(`${label}: no ingress rule, so the ingress controller cannot reach the pod`);
  for (const rule of ingress) {
    const from = rule?.from ?? [];
    if (from.length === 0) throw new Error(`${label}: an ingress rule has no 'from' peers, which permits every pod`);
    if (!from.some((peer) => peer.namespaceSelector ?? peer.podSelector ?? peer.ipBlock)) {
      throw new Error(`${label}: an ingress 'from' peer names no selector, which permits every pod`);
    }
    if ((rule.ports ?? []).length === 0) {
      throw new Error(`${label}: an ingress rule names no ports, so every container port is reachable`);
    }
  }

  const egress = spec.egress ?? [];
  if (egress.length === 0) throw new Error(`${label}: no egress rule, so the pod cannot resolve DNS or reach any upstream`);
  const cidrs = [];
  const ports = new Set();
  for (const rule of egress) {
    const to = rule?.to ?? [];
    if (to.length === 0) throw new Error(`${label}: an egress rule has no 'to' peers, which permits every destination`);
    if ((rule.ports ?? []).length === 0) {
      throw new Error(`${label}: an egress rule names no ports, which permits every port to those peers`);
    }
    for (const peer of to) if (peer.ipBlock?.cidr) cidrs.push(peer.ipBlock.cidr);
    for (const port of rule.ports) {
      // `== null` and `0` only: a named port is legal NetworkPolicy, and `!port.port` rejected it.
      if (port.port == null || port.port === 0) {
        throw new Error(`${label}: an egress port rendered as ${String(port.port)}`);
      }
      ports.add(port.port);
    }
  }
  for (const cidr of cidrs) {
    if (cidr === '0.0.0.0/0' || cidr === '::/0') {
      throw new Error(`${label}: egress names ${cidr}, but the template says the whole internet must not be added here`);
    }
  }
  for (const expected of expectedPorts) {
    if (!ports.has(expected)) {
      throw new Error(`${label}: no egress rule reaches port ${String(expected)}, which this store shape needs`);
    }
  }

  const dnsProtocols = new Set(
    egress.flatMap((r) => (r.ports ?? []).filter((p) => p.port === 53).map((p) => p.protocol)),
  );
  for (const protocol of ['UDP', 'TCP']) {
    if (!dnsProtocols.has(protocol)) throw new Error(`${label}: the DNS egress rule is missing ${protocol} 53`);
  }

  console.log(
    `${label}: renders, kubeconform-valid, 1 NetworkPolicy selecting the Deployment's pods, ` +
      `${ingress.length} ingress rule(s) with named peers and ports, ${egress.length} egress rule(s) ` +
      `(${cidrs.length} CIDRs, none unbounded), DNS on UDP+TCP 53`,
  );
}

/** A render that must be refused. A guard nothing exercises is a guard nobody knows still fires. */
function refusesToRender(label, extra, expected) {
  let rendered = false;
  try {
    helm(['template', 'check', CHART, ...RENDER_ARGS, ...extra]);
    rendered = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(expected)) {
      throw new Error(`${label}: refused, but not for the stated reason; expected "${expected}" in:\n${message}`);
    }
  }
  if (rendered) throw new Error(`${label}: rendered, but this configuration must be refused`);
  console.log(`${label}: refused, as it must be`);
}

// The direct-private-IP shape: no proxy, so the app reaches the instance itself on `store.port`.
checkNetworkPolicy(
  'networkPolicy, direct store',
  helm(['template', 'check', CHART, ...RENDER_ARGS, ...NETPOL_BASE]),
  [53, 443, 5432],
);

// The Auth Proxy shape, for a Cloud SQL deployment. Its rules were added to the template and
// rendered by nothing: 3307 for the instance, and 988 for the GKE metadata server the proxy needs
// its Workload Identity token from.
checkNetworkPolicy(
  'networkPolicy, auth-proxy store',
  helm([
    'template',
    'check',
    CHART,
    ...RENDER_ARGS,
    ...NETPOL_BASE,
    '--set',
    'store.authProxy.enabled=true',
    '--set',
    'store.authProxy.instance=p:r:i',
    '--set',
    'store.host=127.0.0.1',
    '--set-json',
    'networkPolicy.peers.cloudsql.apiCidrs=["199.36.153.8/30"]',
  ]),
  [53, 443, 3307, 988],
);

refusesToRender(
  'networkPolicy without an instance CIDR',
  NETPOL_PEERS,
  'instanceCidrs is empty',
);

refusesToRender(
  'networkPolicy, auth-proxy store without an Admin API CIDR',
  [...NETPOL_BASE, '--set', 'store.authProxy.enabled=true', '--set', 'store.authProxy.instance=p:r:i', '--set', 'store.host=127.0.0.1'],
  'apiCidrs is empty',
);
