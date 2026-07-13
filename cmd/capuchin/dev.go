package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"capuchin.dev/sdk"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/testsuite"
)

const devAddr = capuchin.DefaultAddress

func portInUse(addr string) bool {
	conn, err := net.DialTimeout("tcp", addr, 300*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// dev starts the entire local stack from this one binary. If nothing is on the
// Temporal port it embeds a dev server (downloading it on first run) with the web UI;
// if Temporal is already running there it reuses it. Then: in a capuchin project
// (a go.mod requiring the capuchin SDK), it builds and runs YOUR worker with hot reload;
// anywhere else it serves the built-in refund demo in-process.
// State persists to .capuchin/dev.db — delete the dir for a clean slate.
func dev() error {
	fmt.Println("capuchin dev — starting the local stack...")

	var c client.Client
	if portInUse(devAddr) {
		cc, err := client.Dial(client.Options{HostPort: devAddr})
		if err == nil {
			_, err = cc.CheckHealth(context.Background(), &client.CheckHealthRequest{})
		}
		if err != nil {
			return fmt.Errorf("%s is in use but not reachable as Temporal — free it (`lsof -ti :7233 | xargs kill`) and retry: %w", devAddr, err)
		}
		fmt.Println("  (reusing the Temporal already running on " + devAddr + ")")
		c = cc
		defer c.Close()
	} else {
		if err := os.MkdirAll(".capuchin", 0o755); err != nil {
			return fmt.Errorf("create .capuchin dir: %w", err)
		}
		server, err := testsuite.StartDevServer(context.Background(), testsuite.DevServerOptions{
			ClientOptions: &client.Options{HostPort: devAddr},
			DBFilename:    ".capuchin/dev.db",
			EnableUI:      true,
			LogLevel:      "error",
		})
		if err != nil {
			return fmt.Errorf("start temporal dev server: %w", err)
		}
		defer server.Stop()
		c = server.Client()
	}

	if isCapuchinProject(".") {
		return devProject()
	}
	return devDemo(c)
}

// devDemo — no project here: serve the built-in refund demo in-process.
func devDemo(c client.Client) error {
	w, err := capuchin.StartWorker(c, demoAgent())
	if err != nil {
		return err
	}
	defer w.Stop()

	banner("built-in refund demo (run `capuchin init` to start your own agent)")
	waitForInterrupt()
	fmt.Println("\nstopping...")
	return nil
}

// devProject — build the project's worker, run it as a child process, and rebuild +
// restart whenever a .go file (or go.mod/go.sum) changes. A failed build keeps the
// previous worker running.
func devProject() error {
	if _, err := exec.LookPath("go"); err != nil {
		return errors.New("this is a capuchin project, and building your agent worker needs the Go toolchain — install Go (https://go.dev/dl) and retry")
	}

	banner("your project (hot reload on .go changes)")

	r := &workerRunner{}
	defer r.stop()
	r.rebuild()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	last := projectSnapshot(".")
	for {
		select {
		case <-sig:
			fmt.Println("\nstopping...")
			return nil
		case <-ticker.C:
			snap := projectSnapshot(".")
			if snap != last {
				last = snap
				fmt.Println("  change detected — rebuilding worker...")
				r.rebuild()
			}
		}
	}
}

func banner(workerLine string) {
	fmt.Println()
	fmt.Println("  temporal    " + devAddr)
	fmt.Println("  web ui      http://localhost:8233")
	fmt.Println("  worker      " + workerLine)
	fmt.Println("  model       " + capuchin.ActiveModelLabel())
	fmt.Println()
	fmt.Println("  Try:  capuchin chat   (in another terminal)")
	fmt.Println("  Ctrl-C to stop.")
	fmt.Println()
}

func waitForInterrupt() {
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
}

// isCapuchinProject — a go.mod in dir that mentions the capuchin SDK module.
func isCapuchinProject(dir string) bool {
	b, err := os.ReadFile(filepath.Join(dir, "go.mod"))
	if err != nil {
		return false
	}
	return strings.Contains(string(b), "capuchin.dev/sdk")
}

// workerRunner owns the project worker child process across rebuilds.
type workerRunner struct {
	cmd  *exec.Cmd
	done chan struct{}
}

const workerBin = ".capuchin/bin/worker"

func (r *workerRunner) rebuild() {
	build := exec.Command("go", "build", "-o", workerBin, ".")
	out, err := build.CombinedOutput()
	if err != nil {
		fmt.Printf("  build failed (previous worker still running):\n%s\n", indent(string(out)))
		return
	}
	r.stop()
	cmd := exec.Command(workerBin)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	cmd.Env = append(os.Environ(), "TEMPORAL_ADDRESS="+devAddr)
	if err := cmd.Start(); err != nil {
		fmt.Println("  start worker:", err)
		return
	}
	done := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(done)
	}()
	r.cmd, r.done = cmd, done
}

func (r *workerRunner) stop() {
	if r.cmd == nil || r.cmd.Process == nil {
		return
	}
	_ = r.cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-r.done:
	case <-time.After(3 * time.Second):
		_ = r.cmd.Process.Kill()
		<-r.done
	}
	r.cmd, r.done = nil, nil
}

// projectSnapshot fingerprints the source tree (paths + mtimes of .go files and
// go.mod/go.sum), skipping hidden dirs and node_modules. Polled once a second —
// cheap enough for any sane project size.
func projectSnapshot(root string) string {
	var b strings.Builder
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if p == root {
			return nil
		}
		if d.IsDir() {
			name := d.Name()
			if strings.HasPrefix(name, ".") || name == "node_modules" {
				return fs.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(p, ".go") || d.Name() == "go.mod" || d.Name() == "go.sum" {
			if info, err := d.Info(); err == nil {
				fmt.Fprintf(&b, "%s:%d;", p, info.ModTime().UnixNano())
			}
		}
		return nil
	})
	return b.String()
}

func indent(s string) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	return "    " + strings.Join(lines, "\n    ")
}
