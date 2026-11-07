# Deploy Livechatty

Livechatty needs a Node.js server and persistent storage for accounts and chat
history. Opening a website cannot start `npm` on a visitor's device. The
included Docker Compose setup runs the app in the background on a Linux server,
stores its database in a persistent volume, and uses Caddy to obtain HTTPS.

## Requirements

- A Linux server with Docker Engine and the Docker Compose plugin.
- A domain you own. Check with a domain registrar whether `livechatty.org` is
  available and register it if you want to use that address. A registry lookup
  is not a reservation or a guarantee of availability.
- DNS access for the domain and a server with public inbound ports 80 and 443.

## Start the website

1. Clone this repository onto the server and enter the repository directory.
2. Copy `.env.example` to `.env`. Set `LIVECHATTY_DOMAIN` to the domain you
   registered (for example, `livechatty.org`).
3. At your domain registrar, point the domain's `A` record to the server's
   public IPv4 address. If the server has IPv6, configure its `AAAA` record
   too. Allow DNS time to propagate.
4. Run `docker compose up -d --build`.
5. Check startup with `docker compose ps` and `docker compose logs caddy app`.
   Caddy provisions HTTPS automatically after DNS points to the server and
   ports 80 and 443 are reachable.

The app listens only on the private Docker network; Caddy is the public
HTTPS entry point. User accounts and messages persist in the `chat-data`
volume. Back up this volume regularly. Do not commit `.env` or database files.

To update the app after pulling new repository changes, run
`docker compose up -d --build`.

## Build a Windows executable

On a computer with Node.js 22 or later, install the project dependencies and
run `npm run build:exe`. This creates `dist/Livechatty.exe`. Double-clicking
the executable starts the chat server on that computer and opens its local
website in a browser. Its account and message database is saved in the user's
home folder under `Livechatty/chat.sqlite`.

The executable is for running a local copy. It does not publish the app to the
internet or keep the chat online when the computer is off. Use the Docker
deployment above for a shared website.
