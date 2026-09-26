-- R5 district meeting prep adds an explicit reviewed state; existing prep states remain unchanged.
ALTER TYPE "meeting_prep_status" ADD VALUE IF NOT EXISTS 'reviewed';
