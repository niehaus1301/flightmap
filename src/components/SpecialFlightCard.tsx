import './SpecialFlightCard.css'
import { getCardWebpPath } from '../utils/specialFlightImages'

interface SpecialFlightCardProps {
  title: string
  description: string
  image: string
  from: string
  to: string
  date: string
  visible: boolean
  onClose: () => void
}

export default function SpecialFlightCard({ title, description, image, from, to, date, visible, onClose }: SpecialFlightCardProps) {
  const webpPath = getCardWebpPath(image)

  return (
    <div className={`special-flight-card${visible ? ' visible' : ''}`}>
      <button className="special-flight-card-close" onClick={onClose}>✕</button>
      <img
        className="special-flight-card-image"
        src={`${import.meta.env.BASE_URL}${webpPath}`}
        alt={title}
        onError={(event) => {
          event.currentTarget.src = `${import.meta.env.BASE_URL}${image}`
        }}
      />
      <div className="special-flight-card-body">
        <div className="special-flight-card-route">{from} → {to} · {date}</div>
        <h2 className="special-flight-card-title">{title}</h2>
        <p className="special-flight-card-desc">{description}</p>
      </div>
    </div>
  )
}
