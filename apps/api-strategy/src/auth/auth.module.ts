// Thin re-export seam for the shared, change-controlled @capiro/auth module.
// (Mirrors apps/workspace/src/auth.) Importing via the seam keeps feature code
// decoupled from the package path.
export { AuthModule } from '@capiro/auth';
