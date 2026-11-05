package service

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

func escapeXML(s string) string {
	var out bytes.Buffer
	_ = xml.EscapeText(&out, []byte(s))
	return out.String()
}
func systemdQuote(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, `%`, `%%`, "\n", `\n`, "\r", `\r`).Replace(s) + `"`
}

func Template(platform, executable, dir string) (string, error) {
	switch platform {
	case "darwin":
		return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>app.oh-my-webbridge</string>
<key>ProgramArguments</key><array><string>%s</string><string>serve</string></array>
<key>EnvironmentVariables</key><dict><key>OMW_HOME</key><string>%s</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardErrorPath</key><string>/dev/null</string>
<key>StandardOutPath</key><string>/dev/null</string>
</dict></plist>
`, escapeXML(executable), escapeXML(dir)), nil
	case "linux":
		return fmt.Sprintf(`[Unit]
Description=oh-my-webbridge local Chrome bridge
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
ExecStart=%s serve
Environment=%s
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
`, systemdQuote(executable), systemdQuote("OMW_HOME="+dir)), nil
	default:
		return "", fmt.Errorf("only macOS and Linux are supported")
	}
}

func Install(dir string) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return err
	}
	content, err := Template(runtime.GOOS, executable, dir)
	if err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	var path string
	if runtime.GOOS == "darwin" {
		path = filepath.Join(home, "Library", "LaunchAgents", "app.oh-my-webbridge.plist")
	} else {
		path = filepath.Join(home, ".config", "systemd", "user", "oh-my-webbridge.service")
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	if err = os.WriteFile(path, []byte(content), 0600); err != nil {
		return err
	}
	if runtime.GOOS == "darwin" {
		return run("launchctl", "bootstrap", "gui/"+strconv.Itoa(os.Getuid()), path)
	}
	if err = run("systemctl", "--user", "daemon-reload"); err != nil {
		return err
	}
	return run("systemctl", "--user", "enable", "--now", "oh-my-webbridge.service")
}
func run(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}
