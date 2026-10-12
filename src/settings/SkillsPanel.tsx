import { api, post } from '../api';
import type { ExtensionsController } from './useExtensions';
export function SkillsPanel({ controller }: { controller: ExtensionsController }) {
  const {
    setMessage,
    busy,
    projects,
    project,
    setProject,
    skills,
    skillDraft,
    setSkillDraft,
    setRemove,
    run,
    load,
  } = controller;
  return (
    <section className="settings-section">
      <h3>Skills</h3>
      <label className="field">
        <span>查看项目 Skill</span>
        <select
          aria-label="Skill 项目"
          value={project}
          onChange={(e) => setProject(e.target.value)}
          disabled={busy}
        >
          <option value="">用户 Skill</option>
          {projects.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <button
        className="secondary"
        disabled={busy}
        onClick={() =>
          setSkillDraft({
            name: '',
            content:
              '---\nname: my-skill\ndescription: 说明何时使用这个 Skill\n---\n\n填写执行步骤。\n',
          })
        }
      >
        新建 Skill
      </button>
      <div className="management-list">
        {skills.map((skill) => (
          <div className="management-item" key={skill.path}>
            <div>
              <strong>{skill.name}</strong>
            </div>
            <div className="button-row">
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await post('/skills/enabled', {
                      project: project || undefined,
                      path: skill.path,
                      enabled: !skill.enabled,
                    });
                    await load();
                  })
                }
              >
                {skill.enabled ? '停用' : '启用'}
              </button>
              {skill.editable && (
                <>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const value = await api<{ content: string }>(
                          `/skills/${encodeURIComponent(skill.path.replaceAll('\\', '/').split('/').at(-2)!)}/content`,
                        );
                        setSkillDraft({
                          name: skill.path.replaceAll('\\', '/').split('/').at(-2)!,
                          content: value.content,
                          editing: true,
                        });
                      })
                    }
                  >
                    编辑
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      setRemove({
                        kind: 'skill',
                        name: skill.path.replaceAll('\\', '/').split('/').at(-2)!,
                      })
                    }
                  >
                    删除
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
      {skillDraft && (
        <form
          className="management-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await api('/skills', {
                method: 'PUT',
                body: JSON.stringify({
                  name: skillDraft.name,
                  content: skillDraft.content,
                  replace: !!skillDraft.editing,
                }),
              });
              setSkillDraft(null);
              await load();
              setMessage('Skill 已保存');
            });
          }}
        >
          <label className="field">
            <span>Skill 目录名</span>
            <input
              aria-label="Skill 目录名"
              value={skillDraft.name}
              readOnly={skillDraft.editing}
              required
              pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}"
              onChange={(e) => setSkillDraft({ ...skillDraft, name: e.target.value })}
            />
          </label>
          <label className="field">
            <span>SKILL.md</span>
            <textarea
              aria-label="Skill 内容"
              rows={9}
              value={skillDraft.content}
              onChange={(e) => setSkillDraft({ ...skillDraft, content: e.target.value })}
            />
          </label>
          <div className="button-row">
            <button className="primary" disabled={busy}>
              保存 Skill
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setSkillDraft(null)}
            >
              取消编辑
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
