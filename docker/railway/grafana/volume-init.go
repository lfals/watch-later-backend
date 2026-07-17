package main

import (
	"fmt"
	"os"
	"strconv"
	"syscall"
)

func main() {
	if len(os.Args) < 5 {
		fmt.Fprintln(os.Stderr, "usage: volume-init <uid> <gid> <data-dir> <command> [args...]")
		os.Exit(2)
	}
	uid, err := strconv.Atoi(os.Args[1])
	if err != nil { panic(err) }
	gid, err := strconv.Atoi(os.Args[2])
	if err != nil { panic(err) }
	dataDir := os.Args[3]
	if err := os.MkdirAll(dataDir, 0750); err != nil { panic(err) }
	if err := os.Chown(dataDir, uid, gid); err != nil { panic(err) }
	if err := syscall.Setgroups([]int{gid}); err != nil { panic(err) }
	if err := syscall.Setgid(gid); err != nil { panic(err) }
	if err := syscall.Setuid(uid); err != nil { panic(err) }
	if err := syscall.Exec(os.Args[4], os.Args[4:], os.Environ()); err != nil { panic(err) }
}
