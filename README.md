# mend — Command-Line Patch Engine

> A Node.js 22 CLI project developed for the **make.fun First Crown: Build Mend** challenge.

[![Node.js](https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Project](https://img.shields.io/badge/Category-Developer%20Tools-6C63FF)](https://github.com/VadimSlim)

## Overview

**mend** explores reliable, automated file patching from the command line. The challenge covers structured JSON edits and multiple text-patch formats, with an emphasis on predictable behavior, safe file handling, and compatibility with an external test harness.

This repository contains a competition entry, **not a released or security-audited package**. Consult the source and challenge specification for the exact formats and edge cases implemented.

## Quick start

**Requirements:** Node.js 22.

```bash
node main.ts [options] [PATCH]
```

For available options, input conventions, and expected behavior, see the challenge's `SPEC.md` and the CLI source.

## Engineering focus

- Command-line interfaces and structured input
- Patch parsing and application
- Filesystem safety and error handling
- Automated testing and specification-driven development

## Competition

Created for **make.fun First Crown — Build Mend** (`hidden-spec-cli-01-run-20261122`).

Competition participation does not imply a prize, ranking, or acceptance. Results are determined by the organizer.

## License

MIT — see the repository's license information.

---

<sub>Part of the [VadimSlim engineering portfolio](https://github.com/VadimSlim).</sub>
