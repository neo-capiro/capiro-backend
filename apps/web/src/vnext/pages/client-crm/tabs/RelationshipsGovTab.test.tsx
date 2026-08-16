import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ClientCrmGovernmentProto } from './RelationshipsGovTab.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';

const client: Client = {
  id: 'client-1',
  name: 'Overland AI',
  website: 'overland.ai',
  description: null,
  productDescription: null,
  primaryContactName: null,
  primaryContactEmail: null,
  primaryContactPhone: null,
  logoS3Key: null,
  logoContentType: null,
  logoUploadedAt: null,
  intakeData: null,
  status: 'active',
  createdAt: '2026-01-15T00:00:00.000Z',
  updatedAt: '2026-01-15T00:00:00.000Z',
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

describe('ClientCrmGovernmentProto', () => {
  it('navigates to the Directory vNext congressional staff page when "View directory" is clicked', () => {
    render(
      <MemoryRouter initialEntries={['/clients']}>
        <Routes>
          <Route
            path="/clients"
            element={
              <>
                <ClientCrmGovernmentProto client={client} />
                <LocationProbe />
              </>
            }
          />
          <Route path="/directory/congressional-staff" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'View directory' }));

    expect(screen.getByTestId('location')).toHaveTextContent('/directory/congressional-staff');
  });
});
