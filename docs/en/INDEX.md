# Documentation

[简体中文](../INDEX.md) · [Documentation](INDEX.md) · [Project home](../../README.en.md)

The documentation follows the lifecycle of an installation. Start with local use for a first run; development commands are not production service commands.

## Getting started

| Task                                               | Guide                                       |
| -------------------------------------------------- | ------------------------------------------- |
| Run on your computer                               | [Local use and development](LOCAL.md)       |
| Work with projects, conversations, tasks and files | [User guide](PRODUCT.md)                    |
| Configure providers and retrieve model catalogs    | [Model providers](PROVIDERS.md)             |
| Look up environment variables and defaults         | [Configuration reference](CONFIGURATION.md) |

## Deployment and operations

| Task                                                        | Guide                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------- |
| Choose an installation method and understand ports/accounts | [Deployment overview](DEPLOYMENT.md)                          |
| Inspect installer flags, certificate handling and updates   | [Installer reference](INSTALL.md)                             |
| Install on a specific platform                              | [Linux](LINUX.md) · [Windows](WINDOWS.md) · [macOS](MACOS.md) |
| Integrate with an existing BT Panel site                    | [BT Panel](BAOTA.md)                                          |
| Back up, migrate, upgrade, roll back or troubleshoot        | [Operations](OPERATIONS.md)                                   |
| Prepare a source repository or distribution                 | [Source and distribution](SERVER-SOURCE.md)                   |

## Development and integration

| Task                                            | Guide                                      |
| ----------------------------------------------- | ------------------------------------------ |
| Understand modules, storage and recovery        | [Architecture](ARCHITECTURE.md)            |
| Use HTTP/WebSocket APIs                         | [API reference](API.md)                    |
| Understand CLI integration scope                | [Executor coverage](CODEX-API-COVERAGE.md) |
| Change code and select tests                    | [Development guide](RD.md)                 |
| Run regression and deployment acceptance checks | [Testing and acceptance](VALIDATION.md)    |
| Review behavior changes                         | [Changelog](RELEASE.md)                    |

Addresses, paths and credentials are placeholders. Commands run from the project root unless stated otherwise; platform guides identify administrator steps. Chinese and English documents share filenames and link to each other at the top.
