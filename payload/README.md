# Unknown Home Module

Requires Unknown Core 0.4.5 or newer, working owner-controlled root, the local Homebrew
Channel elevation helper and compatible webOS local APIs. The ZIP installs a
separate Home app with ID `org.unknown.home.module`; it does not replace an
existing `org.unknown.home` installation.

Enable installs the bundled IPK and elevates its launcher service. Home-button
routing is a separate, initially-off module action. The routing uses only a
volatile surface-manager configuration, preserves other filters and verifies
the resulting chain. A real remote test is still necessary. No firmware,
Developer Mode marker, agreement record, cloud account or privacy setting is changed.

Disable removes the module's enabled Home-key route and closes its foreground
Home app when detected. The installed Home app and preferences remain; its
service refuses launcher operations while the module is disabled or Core safe
mode is active. The Core app remains separate and must not be routed through Home.

The LG Home and Core buttons in Home remain explicit escape routes. Root
modules are trusted code, not sandboxed. An unsupported API or failed rollback
must be shown as requiring recovery, never as a successful restoration.

Home opens with arrow-key focus. On TVs exposing the native cursor-hide API,
launching or returning to Home hides the pointer once; shaking the Magic Remote
can show it again. No permanent pointer restriction is installed. Short clicks
open apps without a hold animation. Holding OK for 650 ms opens the app menu;
the progress cue begins only after the first 300 ms. Moving focus, leaving the
tile with the pointer or leaving Home cancels an unfinished hold.

Version 0.4.3's launch cursor state, short-click feedback and long-press menu
were checked on an LG C4 running webOS 25. Physical shake-to-show still needs an
owner check; other models are unverified. Test only on your own TV with an
independent recovery connection and backups. See the included
MIT license and retain Unknown Digital and Unknown Suite contributors' notices.
