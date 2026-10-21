import React, { createContext, useContext, useEffect, useState } from 'react';

const STORAGE_KEY = 'parth_campaign_recipients';
const CampaignContext = createContext(null);

export function CampaignProvider({ children }) {
  const [recipients, setRecipientsState] = useState([]);

  useEffect(() => {
    try {
      const cached = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      if (Array.isArray(cached)) setRecipientsState(cached);
    } catch (err) {
      setRecipientsState([]);
    }
  }, []);

  const setRecipients = (next) => {
    const rows = typeof next === 'function' ? next(recipients) : next;
    setRecipientsState(rows);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
  };

  const clearRecipients = () => setRecipients([]);

  return (
    <CampaignContext.Provider value={{ recipients, setRecipients, clearRecipients }}>
      {children}
    </CampaignContext.Provider>
  );
}

export function useCampaign() {
  return useContext(CampaignContext);
}
