import {createHash} from 'node:crypto';
import {ForbiddenException,NotFoundException} from '@nestjs/common';
import type {TenantContext} from '@capiro/shared';
import {readMeriResearchPortfolioScope,MERI_RESEARCH_PORTFOLIO_SCOPE_METADATA_KEY} from './research-portfolio-meri-scope.service.js';
import {loadAuthorizedResearchPortfolio} from './research-portfolio-access.js';

export const RESEARCH_PORTFOLIO_ARTIFACT_KINDS = ['research_portfolio_brief','research_portfolio_meeting'] as const;
export function isResearchPortfolioArtifact(kind:string):boolean{return RESEARCH_PORTFOLIO_ARTIFACT_KINDS.some(value=>value===kind);}

/** Current private artifact/conversation ownership and portfolio read authority.
 * The immutable original source receipt is retained; edits are unreviewed text. */
export async function authorizeResearchPortfolioArtifact(tx:any,ctx:TenantContext,artifact:any){
  if(!isResearchPortfolioArtifact(artifact.kind)||artifact.tenantId!==ctx.tenantId||artifact.userId!==ctx.userId||artifact.clientId!==null)throw new NotFoundException('Research Portfolio artifact not found');
  await tx.$executeRaw`SELECT id FROM tenant_memberships WHERE tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid AND status='active' FOR SHARE`;
  if(!await tx.tenantMembership.findFirst({where:{tenantId:ctx.tenantId,userId:ctx.userId,status:'active'},select:{id:true}}))throw new ForbiddenException('Active tenant membership required');
  const metadata=artifact.metadata&&typeof artifact.metadata==='object'&&!Array.isArray(artifact.metadata)?artifact.metadata:{};
  const scope=readMeriResearchPortfolioScope(metadata[MERI_RESEARCH_PORTFOLIO_SCOPE_METADATA_KEY]);
  if(!scope||metadata.schemaVersion!=='research_portfolio_institutional_v1'||!metadata.sourceLineage)throw new ForbiddenException('Research Portfolio artifact provenance is unavailable');
  const expected=createHash('sha256').update(JSON.stringify({kind:scope.kind,researchPortfolioId:scope.researchPortfolioId,researchPortfolioName:scope.researchPortfolioName,researchPortfolioRevision:scope.researchPortfolioRevision})).digest('hex');
  if(scope.scopeVersion!==expected)throw new ForbiddenException('Research Portfolio scope receipt is invalid');
  await tx.$executeRaw`SELECT id FROM research_portfolios WHERE tenant_id=${ctx.tenantId}::uuid AND id=${scope.researchPortfolioId}::uuid FOR SHARE`;
  await tx.$executeRaw`SELECT id FROM research_portfolio_grants WHERE tenant_id=${ctx.tenantId}::uuid AND portfolio_id=${scope.researchPortfolioId}::uuid AND principal_user_id=${ctx.userId}::uuid FOR SHARE`;
  await loadAuthorizedResearchPortfolio(tx,ctx,scope.researchPortfolioId,'viewer');
  await tx.$executeRaw`SELECT id FROM clio_conversations WHERE tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid AND id=${artifact.conversationId}::uuid FOR SHARE`;
  const conversation=await tx.clioConversation.findFirst({where:{id:artifact.conversationId,tenantId:ctx.tenantId,userId:ctx.userId},select:{id:true,clientId:true,metadata:true}});
  const current=readMeriResearchPortfolioScope(conversation?.metadata?.[MERI_RESEARCH_PORTFOLIO_SCOPE_METADATA_KEY]);
  if(!conversation||conversation.clientId!==null||!current||current.researchPortfolioId!==scope.researchPortfolioId||current.scopeVersion!==scope.scopeVersion)throw new NotFoundException('Research Portfolio artifact conversation not found');
  return{scope,metadata};
}
