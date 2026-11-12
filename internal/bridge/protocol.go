package bridge

import (
	"encoding/json"
	"fmt"
)

const Version = "0.2.1"
const Protocol = 1
const MaxMessage = 32 << 20
const MaxArtifact = 100 << 20

type Command struct {
	ID        string          `json:"id,omitempty"`
	Action    string          `json:"action"`
	Session   string          `json:"session"`
	Browser   string          `json:"browser,omitempty"`
	Args      json.RawMessage `json:"args,omitempty"`
	TimeoutMS int             `json:"timeoutMs,omitempty"`
}

type Fault struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Fault) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Message) }

type Packet struct {
	Type      string          `json:"type"`
	ID        string          `json:"id,omitempty"`
	Protocol  int             `json:"protocol,omitempty"`
	Command   *Command        `json:"command,omitempty"`
	Deadline  int64           `json:"deadline,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     *Fault          `json:"error,omitempty"`
	TabID     int             `json:"tabId,omitempty"`
	Method    string          `json:"method,omitempty"`
	SessionID string          `json:"sessionId,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
	Data      string          `json:"data,omitempty"`
	MIME      string          `json:"mimeType,omitempty"`
	// hello fields
	Browser        string   `json:"browser,omitempty"`
	BrowserVersion string   `json:"browserVersion,omitempty"`
	Sessions       []string `json:"sessions,omitempty"`
}

type Reply struct {
	ID     string          `json:"id"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *Fault          `json:"error,omitempty"`
}
