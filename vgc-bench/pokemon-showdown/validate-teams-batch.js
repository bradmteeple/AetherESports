#!/usr/bin/env node
/**
 * Batch team validator. Reads JSON lines from stdin, for example:
 *   {"format": "gen9vgc2024regg", "team": "...showdown team text..."}
 * Outputs one JSON line per input:
 *   {"valid": true} or {"valid": false, "errors": ["..."]}
 */
'use strict';

require('source-map-support/register');
const Teams = require('./dist/sim/teams.js').Teams;
const TeamValidator = require('./dist/sim/team-validator.js').TeamValidator;
const readline = require('readline');

const validators = {};
function getValidator(format) {
	if (!validators[format]) {
		validators[format] = TeamValidator.get(format);
	}
	return validators[format];
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
	try {
		const { format, team } = JSON.parse(line);
		const validator = getValidator(format);
		const parsed = Teams.import(team);
		const result = validator.validateTeam(parsed);
		if (result) {
			console.log(JSON.stringify({ valid: false, errors: result }));
		} else {
			console.log(JSON.stringify({ valid: true }));
		}
	} catch (e) {
		console.log(JSON.stringify({ valid: false, errors: [String(e)] }));
	}
});
