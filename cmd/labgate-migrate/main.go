package main

import (
	"flag"
	"fmt"
	"labgate/internal/config"
	"labgate/internal/migration"
	"os"
)

func main() {
	p := flag.String("database", "", "database file (or read from --config)")
	c := flag.String("config", config.Path(), "configuration file")
	dry := flag.Bool("dry-run", false, "read-only inspection; do not change files")
	flag.Parse()
	if *p == "" {
		v, e := config.Load(*c)
		if e != nil {
			fmt.Fprintln(os.Stderr, "Specify --database or an existing --config")
			os.Exit(1)
		}
		*p = v.Database
	}
	message, e := migration.Run(migration.Options{Path: *p, DryRun: *dry})
	if e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
	fmt.Println(message)
}
