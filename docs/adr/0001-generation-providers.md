# Preserve the Article's generation selection and original cost estimate

Recast uses a global GenerationProvider with a model saved per provider. The Article captures both when generation begins and retains them across retries and restart recovery, because changing settings must not silently reroute an attempt; regeneration explicitly uses the current global selection.

GenerationUsage records retain their original provider/model and EstimatedGenerationCost instead of recalculating historical charges. USD is an estimate or credit/API equivalent, not subscription billing; missing prices remain unknown. This preserves comparable history without claiming knowledge of invoices or subscription limits.

See [generation configuration](../generation.md) for authentication, online catalog discovery and price sources.
