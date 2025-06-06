import { useEffect } from 'react';

// Event type
type UserLoadedEvent = {
    type: "USER_LOADED";
    payload: { id: string; name: string };
  };
  
type User = {
  id: string;
  name: string;
};

// Dispatch event internally
export const handleUserLogin = (user: User) => {
    const event: UserLoadedEvent = {
      type: "USER_LOADED",
      payload: { id: user.id, name: user.name },
    };
  
    window.dispatchEvent(new CustomEvent("USER_LOADED", { detail: event.payload }));
  };