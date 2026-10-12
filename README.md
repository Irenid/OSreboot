# OSreboot

The server side of a self-recovery demo. A machine whose system partition has
been wiped boots over the network, downloads its system image and restores
itself. This server hands out the files and shows the recovery as it happens.

## How it works

The recovering machine has no public IP address, so the server never connects
to it. The machine reports on its own:

- the running system sends a heartbeat every second;
- the wipe script and the recovery environment report stages: `wipe`,
  `netboot`, `download 42%` and so on.

An outage lasts from the last heartbeat before it to the first heartbeat after
it, both measured by the server clock. A changed boot ID in the heartbeat means
the machine rebooted. Every closed outage is appended to `data/outages.csv`
together with the time of each stage.

Pages:

- `/` shows the status of each device: heartbeat, outage timer, current stage
  with progress, previous outages and the downloads served from `files/`;
- `/probe` checks access from the current network: response time, download
  speed and POST requests.

## Running

```sh
cp config/devices.example.json config/devices.json   # add token digests, see Devices
docker compose up -d --build
```

The server listens on `127.0.0.1:8090` only. From the internet it is reached
through a reverse proxy, see Deployment. Files to serve go to `files/`.

Development needs Node.js 24 or newer:

```sh
npm ci
npm run dev      # builds the pages and runs the server with reload
npm run verify   # type check, tests and build
```

Settings come from the environment:

| Variable | Default |
|---|---|
| `PORT` | `8090` |
| `HOST` | `127.0.0.1` (`0.0.0.0` in the container) |
| `HEARTBEAT_TIMEOUT_MS` | `3000` |
| `DATA_DIR` | `data` |
| `FILES_DIR` | `files` |
| `DEVICES_FILE` | `config/devices.json` |

## Devices

Each device has its own token, and the server keeps only its SHA-256 digest:

```sh
openssl rand -hex 32 | tr -d '\n' > laptop.token
sha256sum laptop.token   # goes to tokenSha256 in config/devices.json
```

On the device the token is stored encrypted with its TPM, so the system image
itself carries no secrets:

```sh
systemd-creds encrypt -T --name=osreboot-token laptop.token /etc/credstore.encrypted/osreboot-token
```

## API

| Method | Path | Request and response |
|---|---|---|
| POST | `/api/heartbeat` | `{"boot": "<boot_id>"}`, answers 204 |
| POST | `/api/progress` | `{"stage": "download", "percent": 42, "message": "server.raw.zst"}`, answers 204 |
| GET | `/api/state` | the current state as JSON |
| GET | `/api/events` | the same state as server-sent events |
| GET, HEAD | `/files/<path>` | files from `files/`, byte ranges supported |
| GET | `/health` | `ok` |

POST requests need `Authorization: Bearer <device token>`. A stage name matches
`[a-z0-9][a-z0-9_-]{0,31}`. The status page has titles for `wipe`, `netboot`,
`recovery`, `partition`, `download`, `verify`, `write`, `bootloader` and
`reboot`; other names are shown as they are.

## Client

`client/osreboot-client` is a POSIX shell script that needs only curl:

```sh
osreboot-client heartbeat
osreboot-client stage download 42 "server.raw.zst"
```

It takes the server address from `OSREBOOT_URL` and the token from
`OSREBOOT_TOKEN_FILE` or from the systemd credential `osreboot-token`.
`client/osreboot-heartbeat.service` runs the heartbeat as a service.

Any heartbeat ends an outage, so a script on the running system stops the
heartbeat service before it reports a stage.

## Deployment

The machine that runs the server has no public address either. It is published
through a VPS: an FRP tunnel carries port 8090 to the VPS, and nginx serves it
under `/osreboot/`.

- `deploy/frpc-osreboot.toml` is the tunnel entry for the FRP client.
- `deploy/nginx-osreboot.conf` has the nginx locations. Include them in the
  plain HTTP server, which firmware HTTP Boot uses, and in the HTTPS server.
