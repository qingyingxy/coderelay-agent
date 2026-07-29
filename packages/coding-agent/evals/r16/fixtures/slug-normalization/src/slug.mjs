export function slugify(value) {
	return value.trim().toLowerCase().replace(" ", "-").replace(/[^a-z0-9-]/g, "");
}
