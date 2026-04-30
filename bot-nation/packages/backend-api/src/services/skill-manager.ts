/**
 * Skill Manager
 *
 * Hermes-inspired self-improvement system.
 * - Auto-creates skills after complex tasks
 * - Retrieves relevant skills for new queries
 * - Refines skills based on performance
 */

export interface Skill {
  id: string;
  name: string;
  description: string;
  trigger_pattern: string;
  procedure: string;
  created_from_task_id?: string;
  quality_score: number;
  use_count: number;
  last_used_at?: string;
}

/**
 * Extract skill from completed task
 * Called after action tasks complete
 */
export async function createSkillFromTask(
  taskId: string,
  taskKind: string,
  input: string,
  result: string,
  db: D1Database,
): Promise<Skill | null> {
  if (!input || !result) return null;

  const skillId = `skill-${Date.now()}`;
  const name = `${taskKind}_from_${taskId.slice(-8)}`;

  // Build trigger pattern from input keywords
  const keywords = input.split(/\s+/).slice(0, 5).join("|");
  const triggerPattern = `(?:${keywords})`;

  // Procedure: what was learned
  const procedure = `Task: ${taskKind}
Input: ${input.substring(0, 200)}
Learned procedure: ${result.substring(0, 300)}`;

  try {
    await db
      .prepare(
        `INSERT INTO skills (id, name, description, trigger_pattern, procedure, created_from_task_id, quality_score)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(skillId, name, taskKind, triggerPattern, procedure, taskId, 0.7)
      .run();

    console.log(`[SkillManager] Created skill ${skillId} from task ${taskId}`);
    return { id: skillId, name, description: taskKind, trigger_pattern: triggerPattern, procedure, quality_score: 0.7, use_count: 0 };
  } catch (error) {
    console.error(`[SkillManager] Failed to create skill:`, error);
    return null;
  }
}

/**
 * Find relevant skills for a query
 * Returns top skills matching trigger patterns
 */
export async function findRelevantSkills(
  query: string,
  db: D1Database,
  limit = 3,
): Promise<Skill[]> {
  try {
    const results = await db
      .prepare(
        `SELECT id, name, description, trigger_pattern, procedure, quality_score, use_count, last_used_at
         FROM skills
         WHERE quality_score >= 0.6
         ORDER BY quality_score DESC, use_count DESC
         LIMIT ?`
      )
      .bind(limit)
      .all();

    if (!results.results) return [];

    // Filter by pattern match
    const skills: Skill[] = [];
    for (const row of results.results as any[]) {
      try {
        const pattern = new RegExp(row.trigger_pattern, "i");
        if (pattern.test(query)) {
          skills.push({
            id: row.id,
            name: row.name,
            description: row.description,
            trigger_pattern: row.trigger_pattern,
            procedure: row.procedure,
            quality_score: row.quality_score,
            use_count: row.use_count,
            last_used_at: row.last_used_at,
          });
        }
      } catch {
        // Invalid regex, skip
      }
    }

    if (skills.length > 0) {
      console.log(`[SkillManager] Found ${skills.length} relevant skills for query`);
    }
    return skills;
  } catch (error) {
    console.error(`[SkillManager] Failed to find skills:`, error);
    return [];
  }
}

/**
 * Update skill quality based on performance
 * Called after a skill is used and evaluated
 */
export async function refineSkill(
  skillId: string,
  qualityDelta: number,
  refinementSummary: string,
  db: D1Database,
): Promise<void> {
  try {
    // Update quality score
    await db
      .prepare(
        `UPDATE skills
         SET quality_score = MAX(0.1, MIN(1.0, quality_score + ?)),
             use_count = use_count + 1,
             last_used_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .bind(qualityDelta, skillId)
      .run();

    // Log refinement
    if (qualityDelta !== 0) {
      const refinementId = `refine-${Date.now()}`;
      await db
        .prepare(
          `INSERT INTO skill_refinements (id, skill_id, refinement_type, change_summary, quality_delta, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(refinementId, skillId, "quality_update", refinementSummary, qualityDelta, new Date().toISOString())
        .run();

      console.log(`[SkillManager] Refined skill ${skillId}, delta=${qualityDelta}`);
    }
  } catch (error) {
    console.error(`[SkillManager] Failed to refine skill:`, error);
  }
}

/**
 * Format skills for LLM context
 */
export function formatSkillsForContext(skills: Skill[]): string {
  if (skills.length === 0) return "";

  const lines = skills.map(
    (s) => `- ${s.name} (quality: ${(s.quality_score * 100).toFixed(0)}%, used ${s.use_count}x)\n  ${s.procedure.split("\n")[0]}`
  );

  return `LEARNED SKILLS:\n${lines.join("\n")}\n`;
}
