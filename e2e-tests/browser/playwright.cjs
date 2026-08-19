#!/usr/bin/env node

delete process.env.NO_COLOR;

const { program } = require('playwright/lib/program');

program.parse(process.argv);
