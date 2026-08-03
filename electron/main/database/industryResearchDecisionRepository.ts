import type Database from 'better-sqlite3'
import type {
  IndustryResearchDecisionEventRow,
  IndustryResearchDecisionRow,
  IndustryResearchDecisionTriggerEvaluationRow,
  IndustryResearchDecisionTriggerVersionRow,
  IndustryResearchMonitoringItemVersionRow,
  IndustryResearchMonitoringObservationRow,
  IndustryResearchReviewEventRow,
  IndustryResearchScenarioRow,
  IndustryResearchScenarioSetVersionRow,
  IndustryResearchSkillAdoptionEventRow,
  IndustryResearchSkillSnapshotRow,
  IndustryResearchWorkItemVersionRow,
} from './types'

export function getSkillSnapshotByHash(
  db: Database.Database,
  skillId: string,
  contentHash: string,
): IndustryResearchSkillSnapshotRow | null {
  return (db.prepare(`
    SELECT * FROM industry_research_skill_snapshots
    WHERE skill_id = ? AND content_hash = ?
  `).get(skillId, contentHash) as IndustryResearchSkillSnapshotRow | undefined) ?? null
}

export function getSkillSnapshot(
  db: Database.Database,
  snapshotId: string,
): IndustryResearchSkillSnapshotRow | null {
  return (db.prepare('SELECT * FROM industry_research_skill_snapshots WHERE id = ?')
    .get(snapshotId) as IndustryResearchSkillSnapshotRow | undefined) ?? null
}

export function saveSkillSnapshot(
  db: Database.Database,
  row: IndustryResearchSkillSnapshotRow,
): IndustryResearchSkillSnapshotRow {
  const existing = getSkillSnapshotByHash(db, row.skill_id, row.content_hash)
  if (existing) return existing
  db.prepare(`
    INSERT INTO industry_research_skill_snapshots (
      id, skill_id, content_hash, rule_version, content, source_type,
      source_locator, content_bytes, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.skill_id, row.content_hash, row.rule_version, row.content, row.source_type,
    row.source_locator, row.content_bytes, row.captured_at,
  )
  return getSkillSnapshot(db, row.id)!
}

export function getLatestSkillAdoption(
  db: Database.Database,
  projectId: string,
): IndustryResearchSkillAdoptionEventRow | null {
  return (db.prepare(`
    SELECT * FROM industry_research_skill_adoption_events
    WHERE project_id = ? ORDER BY adopted_at DESC, id DESC LIMIT 1
  `).get(projectId) as IndustryResearchSkillAdoptionEventRow | undefined) ?? null
}

export function getSkillAdoptionByRequestId(
  db: Database.Database,
  requestId: string,
): IndustryResearchSkillAdoptionEventRow | null {
  return (db.prepare('SELECT * FROM industry_research_skill_adoption_events WHERE request_id = ?')
    .get(requestId) as IndustryResearchSkillAdoptionEventRow | undefined) ?? null
}

export function saveSkillAdoption(
  db: Database.Database,
  row: IndustryResearchSkillAdoptionEventRow,
): IndustryResearchSkillAdoptionEventRow {
  const existing = getSkillAdoptionByRequestId(db, row.request_id)
  if (existing) return existing
  db.prepare(`
    INSERT INTO industry_research_skill_adoption_events (
      id, request_id, project_id, event_type, previous_snapshot_id, target_snapshot_id,
      research_snapshot_id, migration_note, diff_schema_version, diff_json,
      review_summary_json, adopted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.request_id, row.project_id, row.event_type, row.previous_snapshot_id,
    row.target_snapshot_id, row.research_snapshot_id, row.migration_note,
    row.diff_schema_version, row.diff_json, row.review_summary_json, row.adopted_at,
  )
  return getSkillAdoptionByRequestId(db, row.request_id)!
}

export function getWorkItemVersionByRequestId(
  db: Database.Database,
  requestId: string,
): IndustryResearchWorkItemVersionRow | null {
  return (db.prepare('SELECT * FROM industry_research_work_item_versions WHERE request_id = ?')
    .get(requestId) as IndustryResearchWorkItemVersionRow | undefined) ?? null
}

export function getLatestWorkItemVersion(
  db: Database.Database,
  projectId: string,
  workItemId: string,
): IndustryResearchWorkItemVersionRow | null {
  return (db.prepare(`
    SELECT * FROM industry_research_work_item_versions
    WHERE project_id = ? AND work_item_id = ? ORDER BY version DESC LIMIT 1
  `).get(projectId, workItemId) as IndustryResearchWorkItemVersionRow | undefined) ?? null
}

export function listLatestWorkItemVersions(
  db: Database.Database,
  projectId: string,
): IndustryResearchWorkItemVersionRow[] {
  return db.prepare(`
    SELECT item.* FROM industry_research_work_item_versions item
    JOIN (
      SELECT work_item_id, MAX(version) AS version
      FROM industry_research_work_item_versions WHERE project_id = ? GROUP BY work_item_id
    ) latest ON latest.work_item_id = item.work_item_id AND latest.version = item.version
    WHERE item.project_id = ? ORDER BY item.created_at DESC, item.id DESC
  `).all(projectId, projectId) as IndustryResearchWorkItemVersionRow[]
}

export function saveWorkItemVersion(
  db: Database.Database,
  row: IndustryResearchWorkItemVersionRow,
): IndustryResearchWorkItemVersionRow {
  const existing = getWorkItemVersionByRequestId(db, row.request_id)
  if (existing) return existing
  db.prepare(`
    INSERT INTO industry_research_work_item_versions (
      id, work_item_id, project_id, version, previous_version_id, request_id, question,
      effort, conclusion_sensitivity, evidence_uncertainty, change_velocity, stop_reason,
      next_trigger_metric, affected_objects_json, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.work_item_id, row.project_id, row.version, row.previous_version_id,
    row.request_id, row.question, row.effort, row.conclusion_sensitivity,
    row.evidence_uncertainty, row.change_velocity, row.stop_reason,
    row.next_trigger_metric, row.affected_objects_json, row.status, row.created_at,
  )
  return getWorkItemVersionByRequestId(db, row.request_id)!
}

export function getScenarioSetVersionByRequestId(
  db: Database.Database,
  requestId: string,
): IndustryResearchScenarioSetVersionRow | null {
  return (db.prepare('SELECT * FROM industry_research_scenario_set_versions WHERE request_id = ?')
    .get(requestId) as IndustryResearchScenarioSetVersionRow | undefined) ?? null
}

export function getScenarioSetVersion(
  db: Database.Database,
  projectId: string,
  versionId: string,
): IndustryResearchScenarioSetVersionRow | null {
  return (db.prepare(`
    SELECT * FROM industry_research_scenario_set_versions WHERE id = ? AND project_id = ?
  `).get(versionId, projectId) as IndustryResearchScenarioSetVersionRow | undefined) ?? null
}

export function getLatestScenarioSetVersion(
  db: Database.Database,
  projectId: string,
  scenarioSetId: string,
): IndustryResearchScenarioSetVersionRow | null {
  return (db.prepare(`
    SELECT * FROM industry_research_scenario_set_versions
    WHERE project_id = ? AND scenario_set_id = ? ORDER BY version DESC LIMIT 1
  `).get(projectId, scenarioSetId) as IndustryResearchScenarioSetVersionRow | undefined) ?? null
}

export function listLatestScenarioSetVersions(
  db: Database.Database,
  projectId: string,
  companyId?: string | null,
): IndustryResearchScenarioSetVersionRow[] {
  const companyClause = companyId === undefined
    ? ''
    : companyId === null ? 'AND item.company_id IS NULL' : 'AND item.company_id = @companyId'
  return db.prepare(`
    SELECT item.* FROM industry_research_scenario_set_versions item
    JOIN (
      SELECT scenario_set_id, MAX(version) AS version
      FROM industry_research_scenario_set_versions WHERE project_id = @projectId GROUP BY scenario_set_id
    ) latest ON latest.scenario_set_id = item.scenario_set_id AND latest.version = item.version
    WHERE item.project_id = @projectId ${companyClause}
    ORDER BY item.created_at DESC, item.id DESC
  `).all({ projectId, companyId }) as IndustryResearchScenarioSetVersionRow[]
}

export function listScenariosForVersion(
  db: Database.Database,
  versionId: string,
): IndustryResearchScenarioRow[] {
  return db.prepare(`
    SELECT * FROM industry_research_scenarios
    WHERE scenario_set_version_id = ? ORDER BY CASE name WHEN 'bear' THEN 1 WHEN 'base' THEN 2 ELSE 3 END
  `).all(versionId) as IndustryResearchScenarioRow[]
}

export function saveScenarioSetVersion(
  db: Database.Database,
  row: IndustryResearchScenarioSetVersionRow,
  scenarios: IndustryResearchScenarioRow[],
): IndustryResearchScenarioSetVersionRow {
  const existing = getScenarioSetVersionByRequestId(db, row.request_id)
  if (existing) return existing
  db.prepare(`
    INSERT INTO industry_research_scenario_set_versions (
      id, scenario_set_id, project_id, company_id, version, previous_version_id,
      request_id, data_as_of, valuation_date, valuation_method, methodology_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.scenario_set_id, row.project_id, row.company_id, row.version,
    row.previous_version_id, row.request_id, row.data_as_of, row.valuation_date,
    row.valuation_method, row.methodology_version, row.created_at,
  )
  const insert = db.prepare(`
    INSERT INTO industry_research_scenarios (
      id, scenario_set_version_id, name, weight_pct, assumptions_json, valuation_inputs_json, fact_ids_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  for (const scenario of scenarios) {
    insert.run(
      scenario.id, scenario.scenario_set_version_id, scenario.name, scenario.weight_pct,
      scenario.assumptions_json, scenario.valuation_inputs_json, scenario.fact_ids_json,
    )
  }
  return getScenarioSetVersionByRequestId(db, row.request_id)!
}

export function getDecision(
  db: Database.Database,
  projectId: string,
  decisionId: string,
): IndustryResearchDecisionRow | null {
  return (db.prepare('SELECT * FROM industry_research_decisions WHERE id = ? AND project_id = ?')
    .get(decisionId, projectId) as IndustryResearchDecisionRow | undefined) ?? null
}

export function createDecision(db: Database.Database, row: IndustryResearchDecisionRow): IndustryResearchDecisionRow {
  db.prepare(`
    INSERT INTO industry_research_decisions (id, project_id, company_id, created_at)
    VALUES (?, ?, ?, ?)
  `).run(row.id, row.project_id, row.company_id, row.created_at)
  return getDecision(db, row.project_id, row.id)!
}

export function getDecisionEventByRequestId(
  db: Database.Database,
  requestId: string,
): IndustryResearchDecisionEventRow | null {
  return (db.prepare('SELECT * FROM industry_research_decision_events WHERE request_id = ?')
    .get(requestId) as IndustryResearchDecisionEventRow | undefined) ?? null
}

export function getDecisionEventByTriggerEvaluation(
  db: Database.Database,
  projectId: string,
  evaluationId: string,
): IndustryResearchDecisionEventRow | null {
  return (db.prepare(`
    SELECT * FROM industry_research_decision_events
    WHERE project_id = ? AND source_trigger_evaluation_id = ?
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(projectId, evaluationId) as IndustryResearchDecisionEventRow | undefined) ?? null
}

export function getLatestDecisionEvent(
  db: Database.Database,
  projectId: string,
  decisionId: string,
): IndustryResearchDecisionEventRow | null {
  return (db.prepare(`
    SELECT * FROM industry_research_decision_events
    WHERE project_id = ? AND decision_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(projectId, decisionId) as IndustryResearchDecisionEventRow | undefined) ?? null
}

export function listLatestDecisionEvents(
  db: Database.Database,
  projectId: string,
): IndustryResearchDecisionEventRow[] {
  return db.prepare(`
    SELECT event.* FROM industry_research_decision_events event
    WHERE event.project_id = ? AND event.id = (
      SELECT latest.id FROM industry_research_decision_events latest
      WHERE latest.project_id = event.project_id AND latest.decision_id = event.decision_id
      ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
    )
    ORDER BY event.created_at DESC, event.id DESC
  `).all(projectId) as IndustryResearchDecisionEventRow[]
}

export function listDecisionEvents(
  db: Database.Database,
  projectId: string,
  decisionId: string,
): IndustryResearchDecisionEventRow[] {
  return db.prepare(`
    SELECT * FROM industry_research_decision_events
    WHERE project_id = ? AND decision_id = ? ORDER BY created_at, id
  `).all(projectId, decisionId) as IndustryResearchDecisionEventRow[]
}

export function saveDecisionEvent(
  db: Database.Database,
  row: IndustryResearchDecisionEventRow,
): IndustryResearchDecisionEventRow {
  const existing = getDecisionEventByRequestId(db, row.request_id)
  if (existing) return existing
  db.prepare(`
    INSERT INTO industry_research_decision_events (
      id, request_id, decision_id, project_id, previous_event_id, event_type, action,
      rationale, data_as_of, valuation_date, valid_until, invalidation_condition,
      skill_snapshot_id, research_snapshot_id, scenario_set_version_id, work_item_ids_json,
      fact_ids_json, evidence_ids_json, hypothesis_ids_json, source_trigger_evaluation_id,
      market_snapshot_id, valuation_snapshot_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.request_id, row.decision_id, row.project_id, row.previous_event_id,
    row.event_type, row.action, row.rationale, row.data_as_of, row.valuation_date,
    row.valid_until, row.invalidation_condition, row.skill_snapshot_id,
    row.research_snapshot_id, row.scenario_set_version_id, row.work_item_ids_json,
    row.fact_ids_json, row.evidence_ids_json, row.hypothesis_ids_json,
    row.source_trigger_evaluation_id, row.market_snapshot_id, row.valuation_snapshot_id,
    row.created_at,
  )
  return getDecisionEventByRequestId(db, row.request_id)!
}

export function getMonitoringItemVersionByRequestId(
  db: Database.Database,
  requestId: string,
): IndustryResearchMonitoringItemVersionRow | null {
  return (db.prepare('SELECT * FROM industry_research_monitoring_item_versions WHERE request_id = ?')
    .get(requestId) as IndustryResearchMonitoringItemVersionRow | undefined) ?? null
}

export function getLatestMonitoringItemVersion(
  db: Database.Database,
  projectId: string,
  monitoringItemId: string,
): IndustryResearchMonitoringItemVersionRow | null {
  return (db.prepare(`
    SELECT * FROM industry_research_monitoring_item_versions
    WHERE project_id = ? AND monitoring_item_id = ? ORDER BY version DESC LIMIT 1
  `).get(projectId, monitoringItemId) as IndustryResearchMonitoringItemVersionRow | undefined) ?? null
}

export function listLatestMonitoringItemVersions(
  db: Database.Database,
  projectId: string,
): IndustryResearchMonitoringItemVersionRow[] {
  return db.prepare(`
    SELECT item.* FROM industry_research_monitoring_item_versions item
    JOIN (
      SELECT monitoring_item_id, MAX(version) AS version
      FROM industry_research_monitoring_item_versions WHERE project_id = ? GROUP BY monitoring_item_id
    ) latest ON latest.monitoring_item_id = item.monitoring_item_id AND latest.version = item.version
    WHERE item.project_id = ? ORDER BY item.created_at DESC, item.id DESC
  `).all(projectId, projectId) as IndustryResearchMonitoringItemVersionRow[]
}

export function saveMonitoringItemVersion(
  db: Database.Database,
  row: IndustryResearchMonitoringItemVersionRow,
): IndustryResearchMonitoringItemVersionRow {
  const existing = getMonitoringItemVersionByRequestId(db, row.request_id)
  if (existing) return existing
  db.prepare(`
    INSERT INTO industry_research_monitoring_item_versions (
      id, monitoring_item_id, project_id, version, previous_version_id, request_id,
      name, value_kind, frequency, source_name, source_ref, unit, timing_type,
      stale_after_ms, next_review_at, hypothesis_ids_json, scenario_set_ids_json,
      decision_ids_json, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.monitoring_item_id, row.project_id, row.version, row.previous_version_id,
    row.request_id, row.name, row.value_kind, row.frequency, row.source_name, row.source_ref,
    row.unit, row.timing_type, row.stale_after_ms, row.next_review_at,
    row.hypothesis_ids_json, row.scenario_set_ids_json, row.decision_ids_json,
    row.status, row.created_at,
  )
  return getMonitoringItemVersionByRequestId(db, row.request_id)!
}

export function getMonitoringObservationByRequestId(
  db: Database.Database,
  requestId: string,
): IndustryResearchMonitoringObservationRow | null {
  return (db.prepare('SELECT * FROM industry_research_monitoring_observations WHERE request_id = ?')
    .get(requestId) as IndustryResearchMonitoringObservationRow | undefined) ?? null
}

export function getMonitoringObservation(
  db: Database.Database,
  projectId: string,
  observationId: string,
): IndustryResearchMonitoringObservationRow | null {
  return (db.prepare(`
    SELECT * FROM industry_research_monitoring_observations WHERE id = ? AND project_id = ?
  `).get(observationId, projectId) as IndustryResearchMonitoringObservationRow | undefined) ?? null
}

export function listLatestMonitoringObservations(
  db: Database.Database,
  projectId: string,
  monitoringItemId: string,
  limit = 2,
): IndustryResearchMonitoringObservationRow[] {
  return db.prepare(`
    SELECT * FROM industry_research_monitoring_observations
    WHERE project_id = ? AND monitoring_item_id = ?
    ORDER BY observed_at DESC, id DESC LIMIT ?
  `).all(projectId, monitoringItemId, Math.min(100, Math.max(1, limit))) as IndustryResearchMonitoringObservationRow[]
}

export function saveMonitoringObservation(
  db: Database.Database,
  row: IndustryResearchMonitoringObservationRow,
): IndustryResearchMonitoringObservationRow {
  const existing = getMonitoringObservationByRequestId(db, row.request_id)
  if (existing) return existing
  db.prepare(`
    INSERT INTO industry_research_monitoring_observations (
      id, request_id, project_id, monitoring_item_id, monitoring_item_version_id,
      value_number, value_text, unit, source_ref, observed_at, available_at,
      data_as_of, methodology_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.request_id, row.project_id, row.monitoring_item_id,
    row.monitoring_item_version_id, row.value_number, row.value_text, row.unit,
    row.source_ref, row.observed_at, row.available_at, row.data_as_of,
    row.methodology_version, row.created_at,
  )
  return getMonitoringObservationByRequestId(db, row.request_id)!
}

export function getTriggerVersionByRequestId(
  db: Database.Database,
  requestId: string,
): IndustryResearchDecisionTriggerVersionRow | null {
  return (db.prepare('SELECT * FROM industry_research_decision_trigger_versions WHERE request_id = ?')
    .get(requestId) as IndustryResearchDecisionTriggerVersionRow | undefined) ?? null
}

export function getLatestTriggerVersion(
  db: Database.Database,
  projectId: string,
  triggerId: string,
): IndustryResearchDecisionTriggerVersionRow | null {
  return (db.prepare(`
    SELECT * FROM industry_research_decision_trigger_versions
    WHERE project_id = ? AND trigger_id = ? ORDER BY version DESC LIMIT 1
  `).get(projectId, triggerId) as IndustryResearchDecisionTriggerVersionRow | undefined) ?? null
}

export function listLatestTriggerVersions(
  db: Database.Database,
  projectId: string,
): IndustryResearchDecisionTriggerVersionRow[] {
  return db.prepare(`
    SELECT item.* FROM industry_research_decision_trigger_versions item
    JOIN (
      SELECT trigger_id, MAX(version) AS version
      FROM industry_research_decision_trigger_versions WHERE project_id = ? GROUP BY trigger_id
    ) latest ON latest.trigger_id = item.trigger_id AND latest.version = item.version
    WHERE item.project_id = ? ORDER BY item.created_at DESC, item.id DESC
  `).all(projectId, projectId) as IndustryResearchDecisionTriggerVersionRow[]
}

export function saveTriggerVersion(
  db: Database.Database,
  row: IndustryResearchDecisionTriggerVersionRow,
): IndustryResearchDecisionTriggerVersionRow {
  const existing = getTriggerVersionByRequestId(db, row.request_id)
  if (existing) return existing
  db.prepare(`
    INSERT INTO industry_research_decision_trigger_versions (
      id, trigger_id, project_id, decision_id, monitoring_item_id,
      monitoring_item_version_id, version, previous_version_id, request_id,
      metric_name, operator, threshold_number, threshold_text, validation_window_ms,
      action_if_not_triggered, proposed_action_if_triggered, expires_at, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.trigger_id, row.project_id, row.decision_id, row.monitoring_item_id,
    row.monitoring_item_version_id, row.version, row.previous_version_id, row.request_id,
    row.metric_name, row.operator, row.threshold_number, row.threshold_text,
    row.validation_window_ms, row.action_if_not_triggered,
    row.proposed_action_if_triggered, row.expires_at, row.status, row.created_at,
  )
  return getTriggerVersionByRequestId(db, row.request_id)!
}

export function getTriggerEvaluationByRequestId(
  db: Database.Database,
  requestId: string,
): IndustryResearchDecisionTriggerEvaluationRow | null {
  return (db.prepare('SELECT * FROM industry_research_decision_trigger_evaluations WHERE request_id = ?')
    .get(requestId) as IndustryResearchDecisionTriggerEvaluationRow | undefined) ?? null
}

export function getTriggerEvaluation(
  db: Database.Database,
  projectId: string,
  evaluationId: string,
): IndustryResearchDecisionTriggerEvaluationRow | null {
  return (db.prepare(`
    SELECT * FROM industry_research_decision_trigger_evaluations WHERE id = ? AND project_id = ?
  `).get(evaluationId, projectId) as IndustryResearchDecisionTriggerEvaluationRow | undefined) ?? null
}

export function saveTriggerEvaluation(
  db: Database.Database,
  row: IndustryResearchDecisionTriggerEvaluationRow,
): IndustryResearchDecisionTriggerEvaluationRow {
  const existing = getTriggerEvaluationByRequestId(db, row.request_id)
  if (existing) return existing
  db.prepare(`
    INSERT INTO industry_research_decision_trigger_evaluations (
      id, request_id, project_id, trigger_id, trigger_version_id,
      observation_id, result, result_reason, evaluated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.request_id, row.project_id, row.trigger_id, row.trigger_version_id,
    row.observation_id, row.result, row.result_reason, row.evaluated_at,
  )
  return getTriggerEvaluationByRequestId(db, row.request_id)!
}

export function getReviewEventByRequestId(
  db: Database.Database,
  requestId: string,
): IndustryResearchReviewEventRow | null {
  return (db.prepare('SELECT * FROM industry_research_review_events WHERE request_id = ?')
    .get(requestId) as IndustryResearchReviewEventRow | undefined) ?? null
}

export function getLatestReviewEvent(
  db: Database.Database,
  projectId: string,
  reviewGroupId: string,
): IndustryResearchReviewEventRow | null {
  return (db.prepare(`
    SELECT * FROM industry_research_review_events
    WHERE project_id = ? AND review_group_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(projectId, reviewGroupId) as IndustryResearchReviewEventRow | undefined) ?? null
}

export function listLatestReviewEvents(
  db: Database.Database,
  projectId: string,
): IndustryResearchReviewEventRow[] {
  return db.prepare(`
    SELECT event.* FROM industry_research_review_events event
    WHERE event.project_id = ? AND event.id = (
      SELECT latest.id FROM industry_research_review_events latest
      WHERE latest.project_id = event.project_id AND latest.review_group_id = event.review_group_id
      ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
    )
    ORDER BY event.created_at DESC, event.id DESC
  `).all(projectId) as IndustryResearchReviewEventRow[]
}

export function saveReviewEvent(
  db: Database.Database,
  row: IndustryResearchReviewEventRow,
): IndustryResearchReviewEventRow {
  const existing = getReviewEventByRequestId(db, row.request_id)
  if (existing) return existing
  db.prepare(`
    INSERT INTO industry_research_review_events (
      id, request_id, review_group_id, project_id, previous_event_id, kind,
      subject_kind, subject_id, source_event_id, state, reason, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.request_id, row.review_group_id, row.project_id, row.previous_event_id,
    row.kind, row.subject_kind, row.subject_id, row.source_event_id, row.state,
    row.reason, row.payload_json, row.created_at,
  )
  return getReviewEventByRequestId(db, row.request_id)!
}
