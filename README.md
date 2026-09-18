# Plate &amp; Parcel

A shared shopping list for one family. Everyone ticks the same list from their
own phone, changes appear on the others within a second or two, and it keeps
working with no signal and catches up when signal returns.

Not a product, not accepting users, and not a template. It is built for one
household's two warehouse clubs and four specific phones.

---

## Copyright

**Copyright (c) 2026 Air Capital Analytics LLC. All Rights Reserved.**

Proprietary and confidential. See [`LICENSE`](./LICENSE).

**Why this is a public repository.** GitHub Pages serves a site from a
repository root, and free Pages requires that repository to be public. So the
application's source is visible here as a condition of hosting it — **not as a
grant of licence.** Being able to read this code does not confer permission to
copy, modify, publish or use it.

The engineering record for this project — its design notes, defect ledger, build
tooling and source documents — is kept in a separate private repository and is
not published here.

---

## What is in here

Only what the browser downloads: one HTML shell, five ES modules, a service
worker, a manifest and the icons. No build step, no bundler, no dependencies.
The application loads no library, no framework and no font from any origin but
its own.

`config.js` carries a Firebase Realtime Database URL. That is intended: the URL
is not a secret, access is governed by database rules, and every record is
encrypted on the device before it is sent. The passphrase that decrypts them is
typed on each phone and never leaves it.

---

## Security

If you have found a genuine security problem here, please open an issue with
enough detail to reproduce it and no more. Please do not open issues asking for
features, support, or permission to reuse the code.
