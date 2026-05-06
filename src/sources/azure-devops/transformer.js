/**
 * Azure DevOps source — entity transformers.
 *
 * Transforms Azure DevOps REST API responses (work items, sprints)
 * into KnowledgeItem objects for the SEAL Knowledge Engine.
 */

/**
 * Build embedding text for a work item.
 * Combines title + type + state + description (HTML stripped, truncated).
 * @param {object} wi - Azure DevOps work item object
 * @returns {string}
 */
export function buildWorkItemEmbeddingText(wi) {
  const parts = [
    wi.fields['System.Title'],
    wi.fields['System.WorkItemType'],
    wi.fields['System.State'],
    stripHtml(wi.fields['System.Description']).slice(0, 500),
  ].filter(Boolean);
  return parts.join(' ');
}

/**
 * Transform a work item into a KnowledgeItem.
 * @param {object} workItem - Azure DevOps work item from REST API
 * @param {string} org - Azure DevOps organization
 * @param {string} project - Azure DevOps project name
 * @returns {object} KnowledgeItem
 */
export function transformWorkItem(workItem, org, project) {
  const f = workItem.fields;
  const assignedTo = f['System.AssignedTo']?.displayName;
  const createdBy = f['System.CreatedBy']?.displayName;

  return {
    source: 'azure-devops',
    external_id: `ado-${org}-${project}-wi-${workItem.id}`,
    type: 'work-item',
    title: f['System.Title'] || '',
    content: JSON.stringify({
      id: workItem.id,
      type: f['System.WorkItemType'],
      state: f['System.State'],
      assignedTo,
      description: f['System.Description'],
      tags: f['System.Tags'],
      areaPath: f['System.AreaPath'],
      iterationPath: f['System.IterationPath'],
      createdDate: f['System.CreatedDate'],
      changedDate: f['System.ChangedDate'],
      remainingWork: f['Microsoft.VSTS.Scheduling.RemainingWork'],
      url: workItem._links?.html?.href,
    }),
    embedding_text: buildWorkItemEmbeddingText(workItem),
    date: f['System.ChangedDate'] || f['System.CreatedDate'] || null,
    people: [assignedTo, createdBy].filter(Boolean),
    project,
    tags: ['work-item', f['System.WorkItemType']?.toLowerCase()].filter(Boolean),
    meta: { org, project, workItemId: workItem.id },
  };
}

/**
 * Transform a sprint/iteration into a KnowledgeItem.
 * @param {object} iteration - Azure DevOps iteration object
 * @param {string} org - Azure DevOps organization
 * @param {string} project - Azure DevOps project name
 * @returns {object} KnowledgeItem
 */
export function transformSprint(iteration, org, project) {
  const startDate = iteration.attributes?.startDate;
  const finishDate = iteration.attributes?.finishDate;

  return {
    source: 'azure-devops',
    external_id: `ado-${org}-${project}-sprint-${iteration.id}`,
    type: 'sprint',
    title: iteration.name || '',
    content: JSON.stringify({
      id: iteration.id,
      name: iteration.name,
      path: iteration.path,
      startDate,
      finishDate,
      timeFrame: iteration.attributes?.timeFrame,
    }),
    embedding_text: `Sprint ${iteration.name} from ${startDate || '?'} to ${finishDate || '?'}`,
    date: startDate || null,
    people: [],
    project,
    tags: ['sprint'],
    meta: { org, project, iterationId: iteration.id },
  };
}

/**
 * Strip HTML tags from a string.
 * @param {string|null|undefined} html
 * @returns {string}
 */
function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, '').trim();
}
