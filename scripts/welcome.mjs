#!/usr/bin/env node
/**
 * Friendly post-install message for pi-extensions.
 *
 * Runs from the package's postinstall hook, right after the codegraph
 * compatibility patch. It is best-effort and never throws: a plain text
 * note that steers the new user to the docs and reassures them that every
 * extension and skill can be switched off, with no context cost for what
 * stays off.
 */

const message = [
  "",
  "pi-extensions is installed. Welcome!",
  "",
  "This package bundles a good handful of extensions and skills, and you do",
  "not have to keep all of them. Every extension and every skill can be",
  "switched off, and whatever you switch off adds nothing to your context.",
  "",
  "Take a look around and keep only what you love:",
  "  https://seriousjul.github.io/pi-extensions/",
  "",
  "Toggle anything on or off any time with /resources, or with `pi config`.",
  "",
  "Happy hacking!",
  "",
].join("\n");

process.stdout.write(message);
