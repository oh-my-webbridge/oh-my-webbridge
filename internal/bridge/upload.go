package bridge

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"os"
	"path/filepath"
	"sync"
	"syscall"
)

// MaxUpload bounds the file bytes inlined into one Firefox command. Base64 of
// 16 MiB stays below the 32 MiB transport frame.
const MaxUpload = 16 << 20

// UploadBudget bounds the file bytes inlined into all Firefox commands in
// flight. A command holds its bytes until it returns.
const UploadBudget = 64 << 20

// uploadBudget counts the inlined bytes that commands in flight hold.
type uploadBudget struct {
	mu   sync.Mutex
	used int64
}

func (b *uploadBudget) reserve(n int64) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.used+n > UploadBudget {
		return &Fault{"busy", "Firefox uploads in flight would exceed the 64 MiB upload budget; retry after they finish"}
	}
	b.used += n
	return nil
}

func (b *uploadBudget) release(n int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.used -= n
}

// inlining is the state of one command: the bytes it may still inline and the
// bytes it holds in the daemon-wide budget.
type inlining struct {
	left   int64
	held   int64
	budget *uploadBudget
}

func (in *inlining) take(n int64) error {
	if err := in.budget.reserve(n); err != nil {
		return err
	}
	in.held += n
	return nil
}

type uploadFile struct {
	Name string `json:"name"`
	MIME string `json:"mimeType"`
	Data string `json:"data"`
}

// inlineUploads replaces upload paths with file contents for the Firefox
// extension, which cannot read local files. upload steps inside a batch are
// rewritten too and share the 16 MiB command limit. A batch without
// well-formed steps is left for the extension to reject. Each file reserves
// its bytes in budget before it is read; inlineUploads returns the bytes held,
// also with an error, and the caller releases them when the command returns.
func inlineUploads(cmd *Command, budget *uploadBudget) (int64, error) {
	in := &inlining{left: MaxUpload, budget: budget}
	err := in.command(cmd)
	return in.held, err
}

func (in *inlining) command(cmd *Command) error {
	if cmd.Action == "upload" {
		args, err := in.files(cmd.Args)
		if err != nil {
			return err
		}
		cmd.Args = args
		return nil
	}
	var args map[string]json.RawMessage
	var steps []map[string]json.RawMessage
	if json.Unmarshal(cmd.Args, &args) != nil || json.Unmarshal(args["steps"], &steps) != nil {
		return nil
	}
	changed := false
	for i, step := range steps {
		var action string
		if json.Unmarshal(step["action"], &action) != nil || action != "upload" {
			continue
		}
		raw := step["args"]
		if len(raw) == 0 {
			raw = json.RawMessage(`{}`)
		}
		out, err := in.files(raw)
		if err != nil {
			e := fault(err)
			return &Fault{e.Code, fmt.Sprintf("batch step %d: %s", i, e.Message)}
		}
		step["args"] = out
		changed = true
	}
	if !changed {
		return nil
	}
	var err error
	if args["steps"], err = json.Marshal(steps); err != nil {
		return err
	}
	cmd.Args, err = json.Marshal(args)
	return err
}

func (in *inlining) files(raw json.RawMessage) (json.RawMessage, error) {
	var args map[string]json.RawMessage
	if err := json.Unmarshal(raw, &args); err != nil {
		return nil, &Fault{"invalid_args", "upload args: " + err.Error()}
	}
	var paths []string
	if err := json.Unmarshal(args["files"], &paths); err != nil || paths == nil {
		return nil, &Fault{"invalid_args", "upload files must be an array of absolute file paths"}
	}
	files := make([]uploadFile, 0, len(paths))
	for _, path := range paths {
		file, err := in.read(path)
		if err != nil {
			return nil, err
		}
		files = append(files, file)
	}
	var err error
	if args["files"], err = json.Marshal(files); err != nil {
		return nil, err
	}
	return json.Marshal(args)
}

func (in *inlining) read(path string) (uploadFile, error) {
	if !filepath.IsAbs(path) {
		return uploadFile{}, &Fault{"invalid_args", "upload file must be an absolute path: " + path}
	}
	// O_NONBLOCK keeps a FIFO from blocking the open; it is rejected below.
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return uploadFile{}, &Fault{"invalid_args", fmt.Sprintf("read upload file %s: %s", path, cause(err))}
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return uploadFile{}, &Fault{"invalid_args", fmt.Sprintf("read upload file %s: %s", path, cause(err))}
	}
	if !info.Mode().IsRegular() {
		return uploadFile{}, &Fault{"invalid_args", "upload file is not a regular file: " + path}
	}
	if info.Size() > in.left {
		return uploadFile{}, &Fault{"invalid_args", "upload files exceed 16 MiB at " + path}
	}
	if err = in.take(info.Size()); err != nil {
		return uploadFile{}, err
	}
	data, err := io.ReadAll(io.LimitReader(f, in.left+1))
	if err != nil {
		return uploadFile{}, &Fault{"invalid_args", fmt.Sprintf("read upload file %s: %s", path, cause(err))}
	}
	if int64(len(data)) > in.left {
		return uploadFile{}, &Fault{"invalid_args", "upload files exceed 16 MiB at " + path}
	}
	// A file that grew after fstat reserves its extra bytes too.
	if extra := int64(len(data)) - info.Size(); extra > 0 {
		if err = in.take(extra); err != nil {
			return uploadFile{}, err
		}
	}
	in.left -= int64(len(data))
	// Browsers derive File.type from the extension and leave it empty when unknown.
	kind := ""
	if t, _, err := mime.ParseMediaType(mime.TypeByExtension(filepath.Ext(path))); err == nil {
		kind = t
	}
	return uploadFile{Name: filepath.Base(path), MIME: kind, Data: base64.StdEncoding.EncodeToString(data)}, nil
}

// cause drops the operation and path that the messages above already name.
func cause(err error) string {
	var pathErr *fs.PathError
	if errors.As(err, &pathErr) {
		return pathErr.Err.Error()
	}
	return err.Error()
}
