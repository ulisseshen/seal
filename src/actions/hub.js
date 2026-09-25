let registry = null;

export function setActionRegistry(value) {
  registry = value;
}

export async function triggerAction(name, context) {
  if (!registry) return null;
  return registry.trigger(name, context);
}
