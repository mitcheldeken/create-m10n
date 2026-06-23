export const colors = {
	reset: "\x1b[0m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	bold: "\x1b[1m",
};

export const c = {
	error: (msg: string) => `${colors.red}x${colors.reset} ${msg}`,
	success: (msg: string) => `${colors.green}+${colors.reset} ${msg}`,
	warning: (msg: string) => `${colors.yellow}!${colors.reset} ${msg}`,
	info: (msg: string) => `${colors.blue}>${colors.reset} ${msg}`,
	header: (msg: string) =>
		`\n${colors.blue}${"-".repeat(60)}${colors.reset}\n${colors.blue}  ${msg}${colors.reset}\n${colors.blue}${"-".repeat(60)}${colors.reset}\n`,
};
