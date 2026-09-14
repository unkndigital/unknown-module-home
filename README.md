# Unknown Home

App grid, favorites, inputs and optional physical Home-button routing. Installs a separate Home application; Core remains the independent recovery manager.

**Private development candidate 0.4.3.** This repository contains only this module, its build tools and its installable ZIP. Unknown Core is a separate prerequisite; the legacy unkndigital/unknown-home repository is not the modular Core installer.

## Prerequisites

- Install only on a TV you own, with existing owner-controlled root and Unknown Core 0.4.5 or newer. No rooting exploit, LG credentials, firmware or service-login bypass is supplied.
- Keep independent recovery access and backups. Modules execute trusted code with root privileges; they are not sandboxed.
- Read [module behavior and restoration](payload/README.md), [owner-use boundaries](OWNER_USE.md), and [security limits](SECURITY.md).

## Build

On Windows, run **Build.cmd**. It checks Node.js 20+ and npm, installs locked dependencies, checks source and creates a validated module ZIP. It does not connect to a TV or publish anything.

    npm ci --ignore-scripts
    npm test
    npm run build

Output: dist/home-0.4.3.zip and dist/SHA256SUMS.txt. PC architecture is independent of the TV JavaScript runtime. The initial reviewed candidate ZIP and its checksum are also at the repository root. Checksums verify bytes, not publisher identity or safety.

## Install

While this repository is private, download the ZIP while signed into GitHub and transfer it to /media/internal/.unknown-core/modules-inbox using your existing owner-controlled connection. In Core, inspect the module and install it; activation is a separate choice. Core's current GitHub installer supports public repositories, not private-repository authentication. Use the module ZIP, not GitHub's automatic source-code ZIP.

## Scope and Verification

Removes this module's Home-button routing and closes Unknown Home if it is in the foreground. The installed Home app and its preferences remain. Home-button routing is saved as OFF and must be explicitly enabled again later.

Only one LG C4 / webOS 25 owner-device has been used for integration checks. Other models and firmware versions are unverified. Workspace tests cover module contracts; this standalone build checks syntax, manifest rules and archive integrity without executing TV actions. A successful build is not proof of hardware compatibility. No TV logs, personal settings, keys, research payloads or private YouTube helper are included.

## License and Attribution

MIT licensed. Retain the full license and **Unknown Digital and Unknown Suite contributors** copyright notice in copies or substantial portions, including modified versions. Preserve third-party notices. Owner-only project/support rules do not add restrictions to MIT. The license's warranty and liability limitations apply to the extent permitted by law, not as a guarantee against claims. Independent of LG and not endorsed by LG, GitHub or FULU.
