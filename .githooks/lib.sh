resolve_node() {
	if command -v npm >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
		return 0
	fi
	for candidate in "$HOME/.nvm/versions/node"/*/bin /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin"; do
		if [ -x "$candidate/npm" ] && [ -x "$candidate/node" ]; then
			PATH="$candidate:$PATH"
			export PATH
			return 0
		fi
	done
	return 1
}
