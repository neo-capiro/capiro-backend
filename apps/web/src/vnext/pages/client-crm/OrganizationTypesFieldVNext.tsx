import type { ComponentProps } from 'react';
import { OrganizationTypesField as OrganizationTypesFieldCore } from '../../../pages/clients/OrganizationTypesFieldCore.js';
import './organization-types-native.css';

export function OrganizationTypesField(props: ComponentProps<typeof OrganizationTypesFieldCore>) {
  return (
    <div className="capiro-native-org-types">
      <OrganizationTypesFieldCore {...props} />
    </div>
  );
}
