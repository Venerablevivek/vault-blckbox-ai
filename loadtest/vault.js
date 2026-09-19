/**
 * Load test for the Vault API (k6). Run with the stack up, rate limits off, from the repository root:
 *
 *   RATE_LIMIT_ENABLED=false docker compose up -d api
 *   docker run --rm -i --network blackboxai-task_default -v "$PWD/loadtest:/scripts" \
 *     grafana/k6:1.3.0 run /scripts/vault.js
 *
 * Rate limits are switched off because every virtual user comes from one address: with them on,
 * this would measure the limiter, not the service. Three scenarios run together for three minutes:
 * people browsing and searching their documents, people uploading, and anonymous recipients
 * opening a share link. Thresholds make the run fail if latency or errors regress.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://api:4000';
const PASSWORD = 'load-test-passphrase';
const errors = new Rate('errors');

export const options = {
  scenarios: {
    browse: {
      executor: 'ramping-vus',
      exec: 'browse',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 40 },
        { duration: '2m', target: 40 },
        { duration: '30s', target: 0 },
      ],
    },
    upload: {
      executor: 'constant-arrival-rate',
      exec: 'upload',
      rate: 5,
      timeUnit: '1s',
      duration: '3m',
      preAllocatedVUs: 10,
    },
    share: {
      executor: 'constant-arrival-rate',
      exec: 'openShare',
      rate: 20,
      timeUnit: '1s',
      duration: '3m',
      preAllocatedVUs: 20,
    },
  },
  thresholds: {
    errors: ['rate<0.01'],
    'http_req_duration{kind:list}': ['p(95)<300'],
    'http_req_duration{kind:search}': ['p(95)<400'],
    'http_req_duration{kind:overview}': ['p(95)<500'],
    'http_req_duration{kind:upload}': ['p(95)<800'],
    'http_req_duration{kind:share}': ['p(95)<200'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

function jsonPost(url, body, params = {}) {
  return http.post(url, JSON.stringify(body), {
    ...params,
    headers: { 'Content-Type': 'application/json', ...(params.headers || {}) },
  });
}

function cookieFrom(response) {
  const raw = response.headers['Set-Cookie'];
  return raw ? raw.split(';')[0] : '';
}

/** Confirms the address from the verification email, as a person would (sharing needs it). */
function confirmEmail(email) {
  const mailpit = __ENV.MAILPIT_URL || 'http://mailpit:8025';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const list = http.get(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`).json('messages') || [];
    if (list.length > 0) {
      const text = http.get(`${mailpit}/api/v1/message/${list[0].ID}`).json('Text');
      const token = /verify-email#token=(evt_[\w-]+)/.exec(text)[1];
      const verified = jsonPost(`${BASE}/api/auth/email/verify`, { token });
      if (verified.status !== 204) throw new Error(`verify failed: ${verified.status}`);
      return;
    }
    sleep(0.2);
  }
  throw new Error(`no verification email for ${email}`);
}

/** One account with a workspace of 300 documents across 10 folders, and a share link. */
export function setup() {
  const email = `load-${Date.now()}@example.com`;
  const registered = jsonPost(`${BASE}/api/auth/register`, { email, password: PASSWORD });
  if (registered.status !== 201) throw new Error(`register failed: ${registered.status} ${registered.body}`);
  const cookie = cookieFrom(registered);
  const auth = { headers: { Cookie: cookie } };
  confirmEmail(email);
  const workspaceId = http.get(`${BASE}/api/auth/me`, auth).json('workspaces.0.id');

  const folders = [];
  for (let i = 0; i < 10; i += 1) {
    folders.push(
      jsonPost(`${BASE}/api/workspaces/${workspaceId}/folders`, { name: `Folder ${i}` }, auth).json('folder.id'),
    );
  }
  let shareDocument = null;
  for (let i = 0; i < 300; i += 1) {
    const words = ['invoice', 'contract', 'forecast', 'minutes', 'budget', 'roadmap'];
    const text = `Document ${i} about the ${words[i % words.length]} for quarter ${(i % 4) + 1}.\n`;
    const res = http.post(
      `${BASE}/api/workspaces/${workspaceId}/documents${i % 3 === 0 ? '' : `?folderId=${folders[i % 10]}`}`,
      { file: http.file(text, `doc-${i}.txt`, 'text/plain') },
      auth,
    );
    if (res.status !== 201) throw new Error(`seed upload failed: ${res.status} ${res.body}`);
    if (i === 0) shareDocument = res.json('document.id');
  }
  const share = jsonPost(`${BASE}/api/shares`, { documentId: shareDocument, expiresInHours: 24 }, auth);
  const token = share.json('share.url').split('/s/')[1];
  sleep(5); // let the worker read the seeded text, so search has something to find
  return { cookie, workspaceId, folders, token };
}

export function browse(data) {
  const auth = { headers: { Cookie: data.cookie } };
  const tagged = (kind) => ({ ...auth, tags: { kind } });
  const folder = data.folders[Math.floor(Math.random() * data.folders.length)];
  const results = [
    http.get(`${BASE}/api/workspaces/${data.workspaceId}/documents?limit=50`, tagged('list')),
    http.get(`${BASE}/api/workspaces/${data.workspaceId}/documents?folderId=${folder}&limit=50`, tagged('list')),
    http.get(`${BASE}/api/workspaces/${data.workspaceId}/documents?q=budget&limit=50`, tagged('search')),
    http.get(`${BASE}/api/workspaces/${data.workspaceId}/overview`, tagged('overview')),
    http.get(`${BASE}/api/notifications`, tagged('notifications')),
  ];
  for (const res of results) errors.add(!check(res, { 'status is 200': (r) => r.status === 200 }));
  sleep(1);
}

export function upload(data) {
  const res = http.post(
    `${BASE}/api/workspaces/${data.workspaceId}/documents`,
    { file: http.file(`uploaded at ${Date.now()} by a load test\n`, `load-${__VU}-${__ITER}.txt`, 'text/plain') },
    { headers: { Cookie: data.cookie }, tags: { kind: 'upload' } },
  );
  errors.add(!check(res, { 'upload created': (r) => r.status === 201 }));
}

export function openShare(data) {
  const page = http.get(`${BASE}/api/shares/${data.token}`, { tags: { kind: 'share' } });
  const download = http.get(`${BASE}/api/shares/${data.token}/download`, { redirects: 0, tags: { kind: 'share' } });
  errors.add(!check(page, { 'share resolves': (r) => r.status === 200 }));
  errors.add(!check(download, { 'download redirects': (r) => r.status === 302 }));
}
