<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="packages/brand/icons/wordmark-dark.svg">
  <img src="packages/brand/icons/wordmark.svg" alt="omw" height="44">
</picture>

# oh-my-webbridge

[![Checks](https://img.shields.io/github/actions/workflow/status/oh-my-webbridge/oh-my-webbridge/ci.yml?branch=main&label=checks&logo=githubactions&logoColor=white)](https://github.com/oh-my-webbridge/oh-my-webbridge/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/oh-my-webbridge/oh-my-webbridge?label=release&color=101318)](https://github.com/oh-my-webbridge/oh-my-webbridge/releases/latest) [![License](https://img.shields.io/github/license/oh-my-webbridge/oh-my-webbridge)](LICENSE)

A local daemon and a browser extension that let an agent work in the Chrome or Firefox you already use, with your logins.

**[Documentation](https://oh-my-webbridge.github.io/en/)** · [繁體中文](https://oh-my-webbridge.github.io/zh-tw/) · [简体中文](https://oh-my-webbridge.github.io/zh-cn/)

</div>

> [!WARNING]
> **Developer preview**
>
> omw is in developer preview and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

<p align="center">
  <img src="https://raw.githubusercontent.com/oh-my-webbridge/oh-my-webbridge/assets/activity-form.gif" alt="An agent plays The Password Game in a borrowed tab. Its pointer and a focus frame mark the password field, the password appears one character at a time, and the toolbar icon turns amber while the agent has control." width="720">
</p>

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="https://raw.githubusercontent.com/oh-my-webbridge/oh-my-webbridge/assets/activity-read.gif" alt="An agent scrolls through a long article in a background tab while the focus frame marks each section it reads.">
      <p>An agent reads a long article. The focus frame marks each section it scrolls to.</p>
    </td>
    <td width="50%" valign="top">
      <img src="https://raw.githubusercontent.com/oh-my-webbridge/oh-my-webbridge/assets/setup.gif" alt="The setup page finds the daemon, takes the six-digit pairing code and ends on prompt examples.">
      <p>First run: the setup page finds the daemon and takes the code from <code>omw pair</code>.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="https://raw.githubusercontent.com/oh-my-webbridge/oh-my-webbridge/assets/popup.png" alt="The extension popup over The Password Game names the session that controls the tab.">
      <p>The popup names the session that controls the active tab.</p>
    </td>
    <td width="50%" valign="top">
      <img src="https://raw.githubusercontent.com/oh-my-webbridge/oh-my-webbridge/assets/presets.png" alt="A news page in a task tab with its ads and trackers blocked.">
      <p>Task tabs block ads and trackers with the built-in <code>anti-ad</code> preset.</p>
    </td>
  </tr>
</table>

## Install

1. Download the daemon and the extension from [Releases](https://github.com/oh-my-webbridge/oh-my-webbridge/releases/latest).
2. Load the extension in Chrome or Firefox. Its setup page shows the `omw start` and `omw pair` steps.
3. Install the agent skill with `omw install-skill ~/.agents/skills`, then give your agent a browser task.

[Getting started](https://oh-my-webbridge.github.io/en/getting-started/) covers each step and building from source. Scripts can use `omw call` or the [JavaScript SDK](https://oh-my-webbridge.github.io/en/reference/sdk/).

## Development

The repository layout, test suites and release process are in [Development](https://oh-my-webbridge.github.io/en/development/).

## License

[Apache License 2.0](LICENSE). Bundled third-party components are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
