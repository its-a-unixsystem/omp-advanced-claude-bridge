// OMP's toolWireSchema serializes tool parameters to JSON Schema. The Claude
// Agent SDK takes a Zod shape instead, so translate the fields it advertises
// to Claude. OMP still validates and executes the actual tool calls.

import { z } from "zod";

export function jsonSchemaPropertyToZod(prop: Record<string, unknown>): z.ZodTypeAny {
	let base: z.ZodTypeAny;
	if (Array.isArray(prop.enum)) {
		const values: unknown[] = prop.enum;
		if (values.length > 0 && values.every((value) => typeof value === "string")) {
			base = z.enum(values);
		} else if (values.length > 0 && values.every((value): value is string | number | boolean | null =>
			value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
		)) {
			base = z.literal(values);
		} else {
			base = z.unknown();
		}
	} else switch (prop.type) {
		case "string": base = z.string(); break;
		case "number": case "integer": base = z.number(); break;
		case "boolean": base = z.boolean(); break;
		case "array": base = prop.items
			? z.array(jsonSchemaPropertyToZod(prop.items as Record<string, unknown>))
			: z.array(z.unknown()); break;
		case "object": base = z.record(z.string(), z.unknown()); break;
		default: base = z.unknown();
	}
	if (typeof prop.description === "string") base = base.describe(prop.description);
	return base;
}

function flattenObjectSchema(schema: Record<string, unknown>): {
	properties: Record<string, Record<string, unknown>>;
	required: Set<string>;
} | null {
	if (schema.type === "object" && schema.properties && typeof schema.properties === "object") {
		return {
			properties: { ...(schema.properties as Record<string, Record<string, unknown>>) },
			required: new Set(Array.isArray(schema.required) ? schema.required as string[] : []),
		};
	}
	const combinator = Array.isArray(schema.allOf) ? "allOf"
		: Array.isArray(schema.anyOf) ? "anyOf"
		: Array.isArray(schema.oneOf) ? "oneOf"
		: null;
	if (!combinator) return null;
	const branches = (schema[combinator] as unknown[])
		.filter((b): b is Record<string, unknown> => Boolean(b && typeof b === "object"))
		.map(flattenObjectSchema)
		.filter((b): b is NonNullable<typeof b> => b !== null);
	if (branches.length === 0) return null;

	const properties: Record<string, Record<string, unknown>> = {};
	for (const branch of branches) Object.assign(properties, branch.properties);
	const required = combinator === "allOf"
		? new Set(branches.flatMap((b) => [...b.required]))
		: new Set([...branches[0].required].filter((key) => branches.every((b) => b.required.has(key))));
	return { properties, required };
}

export function jsonSchemaToZodShape(schema: unknown): Record<string, z.ZodTypeAny> {
	if (!schema || typeof schema !== "object") return {};
	const flattened = flattenObjectSchema(schema as Record<string, unknown>);
	if (!flattened) return {};
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const [key, prop] of Object.entries(flattened.properties)) {
		const zodProp = jsonSchemaPropertyToZod(prop);
		shape[key] = flattened.required.has(key) ? zodProp : zodProp.optional();
	}
	return shape;
}
