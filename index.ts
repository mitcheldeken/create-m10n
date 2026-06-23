#!/usr/bin/env bun
/**
 * create-m10n
 *
 * Deterministic project scaffolds for agent-native micro-SaaS work.
 */

import { c } from "./src/colors";
import { main } from "./src/cli";

main().catch((error) => {
	console.error(c.error("An error occurred:"), error);
	process.exit(1);
});
