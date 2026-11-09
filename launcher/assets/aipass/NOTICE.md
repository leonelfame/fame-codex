# TH AI Pass browser transport

Adapted from [niawjunior/aipass-bridge](https://github.com/niawjunior/aipass-bridge), MIT license. Original copyright notice and permission text are preserved in LICENSE.txt and the project LICENSES directory.

Fame Codex changes the default loopback port to 17843, brands the browser extension, restricts its site permissions to de.aipass.net, and rejects non-extension browser origins at the bridge boundary. The launcher disables upstream administrative process-control endpoints.

The upstream standalone agent and its filesystem/shell executor are not included. Local tools remain the responsibility of Codex and its approvals.
