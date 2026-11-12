import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

describe('study statistical contrast contract', () => {
  it('keeps the external contrast full-minus-GeneTonic and uses the actual fallback test', () => {
    const code = `source('scripts/study/model.R'); rows <- data.frame(participantId=rep(paste0('SIM',1:6),each=3), condition=rep(c('pnv_basic','pnv_full','genetonic'),6), error=rep(c(0.5,0.2,0.4),6)); e <- paired_effect(rows,'error',reference='genetonic',repeats=100); stopifnot(abs(e$estimate+0.2)<1e-12); t <- study_primary_test(list(fit=NULL,model='fallback'),rows); stopifnot(t$method=='participant paired sign-flip test',is.finite(t$pvalue)); cat('statistical contract passed')`;
    const run = spawnSync('Rscript', ['-e', code], { encoding: 'utf8', timeout: 60000 });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('statistical contract passed');
  }, 65000);
});
