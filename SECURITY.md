# Widal Factory security

The browser bridge can control terminals and read files with the server account's permissions. Access-control flaws, transcript/file disclosure, script injection, credential leaks and unsafe update/runtime installation are security issues.

## Reporting a vulnerability

Report privately to the maintainers of [Widal-Inc/factory-web-ui](https://github.com/Widal-Inc/factory-web-ui). Use [GitHub private vulnerability reporting](https://github.com/Widal-Inc/factory-web-ui/security/advisories/new) if it is enabled. If that page is unavailable, contact a repository maintainer privately to arrange a channel before sharing details. Do not open a public issue, pull request or discussion, and do not send fork reports to the upstream author's personal address.

Include the exact commit, platform, how the server was reached, relevant configuration with secrets removed, reproduction steps and impact. Test only systems you own or are authorized to test. Never include real tokens, cookies, keys, customer data or transcripts in public reports.

## Current support boundary

The documented workflow is [local development from source](INSTALL.md), with inherited telemetry disabled. No Widal release channel, native package, relay service or patch-release timetable is established by this document. Fix delivery is coordinated through reviewed fork changes; this policy promises no response deadline.

Shared Factory sign-in, Setup and deployment authorization are pending integration. Legacy authentication and transport implementations still exist on this base; retiring their setup instructions does not remove their risks. Do not assume that a proxy identity header is validated, that a development port is safe to expose, or that disabling telemetry stops other outbound operations.

## Scope

- Unauthorized terminal input, resizing or other mutations; permission/revocation bypasses in any retained access path.
- Reading files, transcripts, credentials or terminal output outside the intended authorization boundary.
- Script injection through chat, file previews, prompt cards, notifications or rendered content.
- SSH host verification, remote bridge credentials and runtime integrity.
- Installation or update paths selecting untrusted code or contacting unintended infrastructure.
- Provider credentials leaving the server except for the intended provider operation.

An inherited or unsupported path is still worth reporting if it is reachable in the fork. The retired upstream account/relay trust model is not a security guarantee for Widal Factory. Vulnerabilities solely in third-party tools should follow those projects' private reporting policies; coordinate privately with this fork's maintainers if the integration is affected.

See [access and safety](docs/guide.md#access-and-safety), [fork status](docs/fork-status.md) and [third-party notices](THIRD_PARTY_NOTICES.md).
